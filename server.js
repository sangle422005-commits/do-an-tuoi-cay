const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// --- CENTRAL STATE MEMORY ---
let gardenState = {
    moisture: null,      
    airHumidity: null,  // THÊM: Lưu trữ độ ẩm không khí từ API thời tiết
    isPumpOn: false,    
    mode: 'manual',     
    isOffline: true,     
    lastPingTime: 0
};

// --- REALTIME SSE CONNECTION MANAGER ---
let sseClients = [];

function broadcastState() {
    sseClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(gardenState)}\n\n`);
    });
}

// --- HEARTBEAT: AUTOMATICALLY DETECT ESP32 DISCONNECT / POWER LOSS ---
setInterval(() => {
    if (!gardenState.isOffline && (Date.now() - gardenState.lastPingTime > 8000)) {
        gardenState.isOffline = true;
        gardenState.moisture = null;  
        gardenState.isPumpOn = false; // Safety cutoff when offline
        console.log("❌ [ESP32] HARDWARE CONNECTION LOST OR POWER OFF!");
        
        broadcastState();
    }
}, 2000);

// =========================================================
// API LẤY THÔNG SỐ THỜI TIẾT TỪ FRONTEND ĐỂ ĐIỀU KHIỂN TỰ ĐỘNG
// =========================================================
app.post("/api/weather-sync", (req, res) => {
    const { airHumidity } = req.body;
    
    if (airHumidity !== undefined) {
        gardenState.airHumidity = airHumidity;
        
        // Nếu đang ở chế độ AUTO, kiểm tra lại điều kiện ngắt bơm
        if (gardenState.mode === 'auto' && !gardenState.isOffline && gardenState.isPumpOn) {
            // Ví dụ: Nếu độ ẩm không khí >= 80%, ngắt bơm ngay lập tức (trời đang rất ẩm/mưa)
            if (gardenState.airHumidity >= 80) {
                gardenState.isPumpOn = false;
                console.log("🌦️ [THỜI TIẾT] Độ ẩm không khí cao, TỰ ĐỘNG TẮT BƠM!");
                broadcastState();
            }
        }
    }
    res.json({ success: true });
});

// =========================================================
// API FOR ESP32 HARDWARE
// =========================================================
app.post("/api/esp-sync", (req, res) => {
    const { moisture } = req.body;
    let stateChanged = false;
    
    if (moisture !== undefined) {
        if (gardenState.moisture !== moisture) stateChanged = true;
        gardenState.moisture = moisture;
        gardenState.lastPingTime = Date.now(); 
        
        if (gardenState.isOffline) {
            console.log("✅ [ESP32] RECONNECTED!");
            gardenState.isOffline = false;
            stateChanged = true;
        }
    }

    if (gardenState.mode === 'auto' && !gardenState.isOffline) {
        const previousPumpState = gardenState.isPumpOn;
        
        // Logic cơ bản: Đất khô thì bơm, đất ướt thì dừng
        if (gardenState.moisture < 30) {
            // Chỉ cho phép bật bơm nếu độ ẩm không khí bình thường (< 80%)
            if (gardenState.airHumidity === null || gardenState.airHumidity < 80) {
                gardenState.isPumpOn = true;
            }
        } 
        else if (gardenState.moisture >= 85) {
            gardenState.isPumpOn = false;
        }
        
        // Ghi đè khẩn cấp: Nếu không khí quá ẩm (>= 80%), ép tắt máy bơm luôn
        if (gardenState.airHumidity && gardenState.airHumidity >= 80) {
             gardenState.isPumpOn = false;
        }
        
        if (previousPumpState !== gardenState.isPumpOn) stateChanged = true;
    }

    if (stateChanged) {
        broadcastState();
    }

    res.json({ pump: gardenState.isPumpOn });
});

// =========================================================
// API FOR WEB & MOBILE DASHBOARD
// =========================================================
app.get("/api/web-events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Send current state on initial connection
    res.write(`data: ${JSON.stringify(gardenState)}\n\n`);

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    req.on("close", () => {
        sseClients = sseClients.filter(client => client.id !== clientId);
    });
});

app.get("/api/web-sync", (req, res) => {
    res.json(gardenState);
});

app.post("/api/web-control", (req, res) => {
    const { command, value } = req.body;
    
    if (command === 'mode') {
        gardenState.mode = value; 
        if (value === 'auto' && !gardenState.isOffline && gardenState.moisture !== null) {
            // Khi chuyển sang AUTO, kiểm tra lại toàn bộ điều kiện (có thêm điều kiện thời tiết)
            if (gardenState.moisture < 30) {
                if (gardenState.airHumidity === null || gardenState.airHumidity < 80) {
                    gardenState.isPumpOn = true;
                }
            }
            else if (gardenState.moisture >= 65) gardenState.isPumpOn = false;

            if (gardenState.airHumidity && gardenState.airHumidity >= 80) {
                 gardenState.isPumpOn = false;
            }
        }
    } 
    else if (command === 'pump' && !gardenState.isOffline) {
        gardenState.mode = 'manual'; 
        gardenState.isPumpOn = value;
    }

    broadcastState();
    res.json({ success: true, state: gardenState });
});

// Chỗ này bạn có thể chèn thêm API gửi mail (/system-alarm) nếu đang dùng tính năng gửi mail nhé!

app.get("/", (req, res) => {
    const files = fs.readdirSync(__dirname);
    const htmlFile = files.find(file => file.toLowerCase().endsWith(".html"));
    if (htmlFile) res.sendFile(path.join(__dirname, htmlFile));
    else res.send("<h2 style='color:red;'>Lỗi: Không tìm thấy file HTML</h2>");
});
app.use(express.static(__dirname));

// LISTEN ON DYNAMIC PORT FOR RENDER CLOUD
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on Port: ${PORT}`);
});
