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
    lastPingTime: 0,
    scheduledWatering: null // Lưu trữ lịch hẹn: { targetTime: timestamp, durationMs: number, label: string }
};

// --- REALTIME SSE CONNECTION MANAGER ---
let sseClients = [];
let wateringTimer = null; // Bộ đếm tắt bơm khi đang tưới

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

// --- HEARTBEAT & SCHEDULED TIMER CHECKER ---
setInterval(() => {
    // 1. Kiểm tra mất kết nối ESP32
    if (!gardenState.isOffline && (Date.now() - gardenState.lastPingTime > 8000)) {
        gardenState.isOffline = true;
        gardenState.moisture = null;  
        gardenState.isPumpOn = false; 
        clearWateringTimer();
        console.log("❌ [ESP32] HARDWARE CONNECTION LOST OR POWER OFF!");
        broadcastState();
    }

    // 2. Kiểm tra lịch hẹn giờ tưới theo Ngày & Giờ thực tế
    if (gardenState.scheduledWatering && !gardenState.isOffline) {
        const now = Date.now();
        if (now >= gardenState.scheduledWatering.targetTime) {
            const duration = gardenState.scheduledWatering.durationMs;
            console.log(`⏰ [HẸN GIỜ] Đã đến thời gian hẹn! Bật máy bơm trong ${duration / 1000} giây.`);
            
            gardenState.mode = 'manual';
            gardenState.isPumpOn = true;
            gardenState.scheduledWatering = null; // Xóa lịch sau khi đã kích hoạt
            broadcastState();

            // Tự động tắt sau số giây được cấu hình
            clearWateringTimer();
            wateringTimer = setTimeout(() => {
                gardenState.isPumpOn = false;
                console.log("⏰ [Hẹn giờ] Đã hết thời gian tưới theo lịch. Tự động tắt bơm.");
                broadcastState();
                wateringTimer = null;
            }, duration);
        }
    }
}, 1000);

// =========================================================
// API LẤY THÔNG SỐ THỜI TIẾT TỪ FRONTEND
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
        clearWateringTimer();
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
        clearWateringTimer();
    }
    else if (command === 'weatherToggle') {
        gardenState.useWeatherAPI = value;
    }
    // Lệnh tạo lịch hẹn giờ tưới mới theo Ngày & Thời gian cụ thể
    else if (command === 'set_schedule' && !gardenState.isOffline) {
        const { targetTime, durationSeconds, label } = value;
        if (targetTime && durationSeconds) {
            gardenState.scheduledWatering = {
                targetTime: targetTime,
                durationMs: durationSeconds * 1000,
                label: label || "Lịch hẹn cá nhân"
            };
            console.log(`📅 Đã thiết lập lịch hẹn tưới vào lúc: ${new Date(targetTime).toLocaleString('vi-VN')} trong vòng ${durationSeconds} giây.`);
        }
    }
    // Lệnh hủy lịch hẹn
    else if (command === 'cancel_schedule') {
        gardenState.scheduledWatering = null;
        console.log("❌ Đã hủy lịch hẹn tưới.");
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
