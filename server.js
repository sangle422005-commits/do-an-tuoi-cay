const express = require("express");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

// --- BỘ NHỚ TRẠNG THÁI TRUNG TÂM ---
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

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const client = { id: Date.now(), res };
    sseClients.push(client);

    res.write(`data: ${JSON.stringify(gardenState)}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== client.id);
    });
});

// --- HEARTBEAT: TỰ ĐỘNG PHÁT HIỆN MẤT KẾT NỐI ESP32 ---
setInterval(() => {
    if (!gardenState.isOffline && (Date.now() - gardenState.lastPingTime > 8000)) {
        gardenState.isOffline = true;
        gardenState.moisture = null;
        gardenState.isPumpOn = false;
        console.log("❌ [ESP32] Mất kết nối phần cứng!");
        broadcastState();
    }
}, 3000);

// --- API NHẬN DỮ LIỆU TỪ ESP32 ---
app.post('/api/esp-update', (req, res) => {
    const { moisture, isPumpOn, mode } = req.body;
    gardenState.moisture = moisture;
    gardenState.isPumpOn = isPumpOn;
    if (mode) gardenState.mode = mode;
    gardenState.isOffline = false;
    gardenState.lastPingTime = Date.now();

    broadcastState();
    res.json({ status: "OK", serverState: gardenState });
});

// --- API GỬI LỆNH ĐIỀU KHIỂN TỪ WEB XUỐNG ESP32 ---
app.post('/api/web-control', (req, res) => {
    const { isPumpOn, mode } = req.body;
    if (isPumpOn !== undefined) gardenState.isPumpOn = isPumpOn;
    if (mode !== undefined) gardenState.mode = mode;

    broadcastState();
    res.json({ status: "SUCCESS", gardenState });
});

// --- CẤU HÌNH GỬI EMAIL CẢNH BÁO ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'tulatpham@gmail.com', // Thay bằng email của bạn
        pass: 'your_app_password'     // Thay bằng mật khẩu ứng dụng Google của bạn
    }
});

app.post('/api/send-alarm', async (req, res) => {
    const { issueType, message } = req.body;
    const mailOptions = {
        from: 'tulatpham@gmail.com',
        to: 'sanglt3989@gmail.com',
        subject: '🚨 BÁO ĐỘNG KHẨN CẤP: HỆ THỐNG SÂN VƯỜN',
        html: `<h3>Cảnh báo từ hệ thống Smart Garden</h3><p><b>Loại sự cố:</b> ${issueType}</p><p><b>Chi tiết:</b> ${message}</p>`
    };
    try {
        await transporter.sendMail(mailOptions);
        res.send("OK");
    } catch (err) {
        console.error("Lỗi gửi email:", err);
        res.status(500).send("Error");
    }
});

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại Port: ${PORT}`);
});
