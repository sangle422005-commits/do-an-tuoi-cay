const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// --- NTFY CONFIGURATION ---
// Replace this with the unique topic name you subscribed to in the Ntfy app:
const NTFY_TOPIC = "smart-garden-sang-alert-2026"; 

async function sendNtfyAlert(title, message, priority = "high") {
    try {
        const response = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
            method: "POST",
            headers: {
                "Title": title,
                "Priority": priority, // Priority levels: max, high, default, low, min
                "Tags": "warning"
            },
            body: message
        });

        if (response.ok) {
            console.log("📱 Ntfy alert sent successfully!");
            return true;
        } else {
            console.error("❌ Ntfy API Error:", response.statusText);
            return false;
        }
    } catch (err) {
        console.error("❌ Ntfy Request Failed:", err);
        return false;
    }
}

// --- BỘ NHỚ TRUNG TÂM (Lưu trạng thái thực tế) ---
let gardenState = {
    moisture: null,      
    isPumpOn: false,    
    mode: 'manual',     
    isOffline: true,     
    lastPingTime: 0
};

// --- QUẢN LÝ KẾT NỐI REALTIME (SSE) ---
let sseClients = [];

function broadcastState() {
    sseClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(gardenState)}\n\n`);
    });
}

// --- NHỊP TIM: TỰ ĐỘNG PHÁT HIỆN MẤT MẠNG/RÚT ĐIỆN ESP32 ---
setInterval(() => {
    if (!gardenState.isOffline && (Date.now() - gardenState.lastPingTime > 8000)) {
        gardenState.isOffline = true;
        gardenState.moisture = null;  
        gardenState.isPumpOn = false; // Ngắt điện máy bơm an toàn khi rớt mạng
        console.log("❌ [ESP32] ĐÃ MẤT KẾT NỐI PHẦN CỨNG HOẶC MẤT ĐIỆN!");
        
        sendNtfyAlert("❌ ESP32 Mất Kết Nối", "Mất tín hiệu kết nối phần cứng hoặc rớt điện!", "max");
        broadcastState();
    }
}, 2000);

// =========================================================
// API DÀNH CHO MẠCH ESP32
// =========================================================
app.post("/api/esp-sync", (req, res) => {
    const { moisture } = req.body;
    let stateChanged = false;
    
    if (moisture !== undefined) {
        if (gardenState.moisture !== moisture) stateChanged = true;
        gardenState.moisture = moisture;
        gardenState.lastPingTime = Date.now(); 
        
        if (gardenState.isOffline) {
            console.log("✅ [ESP32] ĐÃ KẾT NỐI TRỞ LẠI!");
            gardenState.isOffline = false;
            stateChanged = true;
        }
    }

    if (gardenState.mode === 'auto' && !gardenState.isOffline) {
        const previousPumpState = gardenState.isPumpOn;
        if (gardenState.moisture < 30) gardenState.isPumpOn = true;
        else if (gardenState.moisture >= 85) gardenState.isPumpOn = false;
        
        if (previousPumpState !== gardenState.isPumpOn) stateChanged = true;
    }

    if (stateChanged) {
        broadcastState();
    }

    res.json({ pump: gardenState.isPumpOn });
});

// =========================================================
// API DÀNH CHO GIAO DIỆN WEB ĐIỀU KHIỂN
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
        if (value === 'auto' && !gardenState.isOffline && gardenState.moisture !== null) {
            if (gardenState.moisture < 30) gardenState.isPumpOn = true;
            else if (gardenState.moisture >= 85) gardenState.isPumpOn = false;
        }
    } 
    else if (command === 'pump' && !gardenState.isOffline) {
        gardenState.mode = 'manual'; 
        gardenState.isPumpOn = value;
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

// =========================================================
// ALERT ENDPOINTS
// =========================================================
app.post("/sensor-error", async (req, res) => {
    const { sensor, message } = req.body;
    const ok = await sendNtfyAlert(
        `⚠️ CẢNH BÁO LỖI: ${sensor || 'Cảm biến'}`,
        message || 'Gặp sự cố phần cứng!',
        "high"
    );

    if (ok) res.status(200).send("OK");
    else res.status(500).json({ error: "Failed to send notification" });
});

app.post("/system-alarm", async (req, res) => {
    const { issueType, message } = req.body;
    const ok = await sendNtfyAlert(
        `🚨 BÁO ĐỘNG: ${issueType || 'Khu Vườn'}`,
        message || 'Đất quá khô, cần kiểm tra gấp!',
        "max"
    );

    if (ok) res.status(200).send("OK");
    else res.status(500).json({ error: "Failed to send notification" });
});

// LẮNG NGHE PORT ĐỘNG CHO CLOUD RENDER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại Port: ${PORT}`);
});
