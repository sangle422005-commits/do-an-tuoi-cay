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
    airHumidity: null,  
    useWeatherAPI: true, 
    isPumpOn: false,    
    mode: 'manual',     
    isOffline: true,     
    lastPingTime: 0
};

// --- REALTIME SSE CONNECTION MANAGER ---
let sseClients = [];
let wateringTimer = null; // Biến lưu trữ bộ đếm thời gian tưới

function broadcastState() {
    sseClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(gardenState)}\n\n`);
    });
}

function clearWateringTimer() {
    if (wateringTimer) {
        clearTimeout(wateringTimer);
        wateringTimer = null;
    }
}

// --- HEARTBEAT: AUTOMATICALLY DETECT ESP32 DISCONNECT / POWER LOSS ---
setInterval(() => {
    if (!gardenState.isOffline && (Date.now() - gardenState.lastPingTime > 8000)) {
        gardenState.isOffline = true;
        gardenState.moisture = null;  
        gardenState.isPumpOn = false; // Safety cutoff when offline
        clearWateringTimer(); // Hủy bỏ bộ đếm nếu mất mạng
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
        
        if (gardenState.mode === 'auto' && !gardenState.isOffline && gardenState.isPumpOn) {
            if (gardenState.useWeatherAPI && gardenState.airHumidity >= 80) {
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
        
        if (gardenState.moisture < 30) gardenState.isPumpOn = true;
        else if (gardenState.moisture >= 85) gardenState.isPumpOn = false;
        
        if (gardenState.useWeatherAPI && gardenState.airHumidity && gardenState.airHumidity >= 80) {
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
        clearWateringTimer(); // Đổi chế độ thì hủy bộ đếm hẹn giờ

        if (value === 'auto' && !gardenState.isOffline && gardenState.moisture !== null) {
            if (gardenState.moisture < 30) gardenState.isPumpOn = true;
            else if (gardenState.moisture >= 65) gardenState.isPumpOn = false;

            if (gardenState.useWeatherAPI && gardenState.airHumidity && gardenState.airHumidity >= 80) {
                 gardenState.isPumpOn = false;
            }
        }
    } 
    else if (command === 'pump' && !gardenState.isOffline) {
        gardenState.mode = 'manual'; 
        gardenState.isPumpOn = value;
        clearWateringTimer(); // Tự tay bật/tắt thì hủy mọi bộ đếm
    }
    else if (command === 'weatherToggle') {
        gardenState.useWeatherAPI = value;
    }
    // Lệnh Hẹn giờ tưới từ giao diện Web
    else if (command === 'water_timer' && !gardenState.isOffline) {
        const durationMs = parseInt(value) * 1000;
        if (durationMs > 0) {
            gardenState.mode = 'manual'; // Ép sang chế độ thủ công
            gardenState.isPumpOn = true;
            
            clearWateringTimer(); // Xóa bộ đếm cũ nếu có
            
            console.log(`⏱️ Đã kích hoạt tưới nước trong ${value} giây.`);
            
            // Lên lịch tắt máy bơm sau X giây
            wateringTimer = setTimeout(() => {
                gardenState.isPumpOn = false;
                console.log(`⏱️ Đã hết ${value} giây. Bơm tự động tắt.`);
                broadcastState();
                wateringTimer = null;
            }, durationMs);
        }
    }

    broadcastState();
    res.json({ success: true, state: gardenState });
});

app.get("/", (req, res) => {
    const files = fs.readdirSync(__dirname);
    const htmlFile = files.find(file => file.toLowerCase().endsWith(".html"));
    if (htmlFile) res.sendFile(path.join(__dirname, htmlFile));
    else res.send("<h2 style='color:red;'>Lỗi: Không tìm thấy file HTML</h2>");
});
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on Port: ${PORT}`);
});
