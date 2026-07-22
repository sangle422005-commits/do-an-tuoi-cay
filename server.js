const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Resend } = require("resend");

const app = express();
app.use(cors());
app.use(express.json());

// --- RESEND EMAIL INITIALIZATION ---
const resend = new Resend("re_buaZYAz4_LVvuW24JN6EZTV4nT819r9D2");

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
        
        // Đẩy trạng thái offline tới web ngay lập tức
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

    // Nếu đang bật Auto -> Server tự ra quyết định bơm
    if (gardenState.mode === 'auto' && !gardenState.isOffline) {
        const previousPumpState = gardenState.isPumpOn;
        if (gardenState.moisture < 30) gardenState.isPumpOn = true;
        else if (gardenState.moisture >= 85) gardenState.isPumpOn = false;
        
        if (previousPumpState !== gardenState.isPumpOn) stateChanged = true;
    }

    // Nếu có sự thay đổi dữ liệu, đẩy realtime ngay lập tức
    if (stateChanged) {
        broadcastState();
    }

    res.json({ pump: gardenState.isPumpOn });
});

// =========================================================
// API DÀNH CHO GIAO DIỆN WEB ĐIỀU KHIỂN
// =========================================================

// Endpoint SSE truyền dữ liệu realtime liên tục xuống Frontend
app.get("/api/web-events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Gửi dữ liệu hiện tại ngay khi client vừa mở web
    res.write(`data: ${JSON.stringify(gardenState)}\n\n`);

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    req.on("close", () => {
        sseClients = sseClients.filter(client => client.id !== clientId);
    });
});

// Endpoint fallback dành cho truyền thống (Polling)
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
    // ÉP hệ thống sang Manual khi người dùng thao tác bấm nút
    else if (command === 'pump' && !gardenState.isOffline) {
        gardenState.mode = 'manual'; 
        gardenState.isPumpOn = value;
    }

    // Đẩy trạng thái mới qua SSE
    broadcastState();
    
    res.json({ success: true, state: gardenState });
});

// --- PHÁT FILE HTML TỰ ĐỘNG ---
app.get("/", (req, res) => {
    const files = fs.readdirSync(__dirname);
    const htmlFile = files.find(file => file.toLowerCase().endsWith(".html"));
    if (htmlFile) res.sendFile(path.join(__dirname, htmlFile));
    else res.send("<h2 style='color:red;'>Lỗi: Không tìm thấy file HTML</h2>");
});
app.use(express.static(__dirname));

// =========================================================
// GỬI EMAIL BÁO ĐỘNG VIA RESEND API
// =========================================================
app.post("/sensor-error", async (req, res) => {
    const { sensor, message } = req.body;

    try {
        const data = await resend.emails.send({
            from: 'Smart Garden <onboarding@resend.dev>',
            to: ['sanglt3989@gmail.com'],
            subject: `⚠️ LỖI PHẦN CỨNG: ${sensor || 'Không xác định'}`,
            html: `
                <div style="border: 2px solid #ff9800; padding: 20px;">
                    <h2 style="color: #ff9800;">⚠️ CẢNH BÁO LỖI THIẾT BỊ</h2>
                    <p><b>Vị trí lỗi:</b> ${sensor}</p>
                    <p><b>Chi tiết:</b> <span style="color: #d32f2f;">${message}</span></p>
                </div>
            `
        });

        console.log("📧 Email sensor error sent successfully:", data);
        res.status(200).send("OK");
    } catch (err) {
        console.error("❌ Resend error:", err);
        res.status(500).json({ error: "Failed to send email", details: err.message });
    }
});

app.post("/system-alarm", async (req, res) => {
    const { issueType, message } = req.body;

    try {
        const data = await resend.emails.send({
            from: 'Smart Garden <onboarding@resend.dev>',
            to: ['sanglt3989@gmail.com'],
            subject: "🚨 BÁO ĐỘNG KHẨN CẤP: KHU VƯỜN THIẾU NƯỚC",
            html: `
                <div style="border: 2px solid #f44336; padding: 20px;">
                    <h2 style="color: #f44336;">🚨 BÁO ĐỘNG HỆ THỐNG</h2>
                    <p><b>Phân loại:</b> ${issueType}</p>
                    <p><b>Tình trạng:</b> <span style="color: #d32f2f; font-weight: bold;">${message}</span></p>
                </div>
            `
        });

        console.log("📧 Alarm email sent successfully:", data);
        res.status(200).send("OK");
    } catch (err) {
        console.error("❌ Resend error:", err);
        res.status(500).json({ error: "Failed to send email", details: err.message });
    }
});

// LẮNG NGHE PORT ĐỘNG CHO CLOUD RENDER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại Port: ${PORT}`);
});
