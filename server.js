const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// --- BREVO CONFIGURATION ---
const BREVO_API_KEY = "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";
const SENDER_EMAIL = "alert@brevo-mail.com"; // Uses Brevo's system sender domain
const RECIPIENT_EMAIL = "sanglt3989@gmail.com";

// Helper function to send email via Brevo REST API
async function sendEmailAlert(toEmail, subject, htmlContent) {
    try {
        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": BREVO_API_KEY,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                sender: { name: "Smart Garden Alert", email: SENDER_EMAIL },
                to: [{ email: toEmail }],
                subject: subject,
                htmlContent: htmlContent
            })
        });

        const data = await response.json();
        if (response.ok) {
            console.log("📧 Email sent successfully to:", toEmail, data);
            return true;
        } else {
            console.error("❌ Brevo API Error:", data);
            return false;
        }
    } catch (err) {
        console.error("❌ Email Send Failed:", err);
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
// GỬI EMAIL BÁO ĐỘNG VIA BREVO (TO sanglt3989@gmail.com)
// =========================================================
app.post("/sensor-error", async (req, res) => {
    const { sensor, message } = req.body;

    const htmlContent = `
        <div style="border: 2px solid #ff9800; padding: 20px;">
            <h2 style="color: #ff9800;">⚠️ CẢNH BÁO LỖI THIẾT BỊ</h2>
            <p><b>Vị trí lỗi:</b> ${sensor || 'Không xác định'}</p>
            <p><b>Chi tiết:</b> <span style="color: #d32f2f;">${message}</span></p>
        </div>
    `;

    const success = await sendEmailAlert(
        RECIPIENT_EMAIL, 
        `⚠️ LỖI PHẦN CỨNG: ${sensor || 'Không xác định'}`, 
        htmlContent
    );

    if (success) res.status(200).send("OK");
    else res.status(500).json({ error: "Failed to send email" });
});

app.post("/system-alarm", async (req, res) => {
    const { issueType, message } = req.body;

    const htmlContent = `
        <div style="border: 2px solid #f44336; padding: 20px;">
            <h2 style="color: #f44336;">🚨 BÁO ĐỘNG KHẨN CẤP</h2>
            <p><b>Phân loại:</b> ${issueType}</p>
            <p><b>Tình trạng:</b> <span style="color: #d32f2f; font-weight: bold;">${message}</span></p>
        </div>
    `;

    const success = await sendEmailAlert(
        RECIPIENT_EMAIL, 
        "🚨 BÁO ĐỘNG KHẨN CẤP: KHU VƯỜN THIẾU NƯỚC", 
        htmlContent
    );

    if (success) res.status(200).send("OK");
    else res.status(500).json({ error: "Failed to send email" });
});

// LẮNG NGHE PORT ĐỘNG CHO CLOUD RENDER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại Port: ${PORT}`);
});
