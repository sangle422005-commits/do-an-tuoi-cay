// --- GỬI EMAIL BÁO ĐỘNG ---
const transporter = nodemailer.createTransport({
    service: "gmail", 
    auth: { 
        user: process.env.GMAIL_USER || "tulatpham@gmail.com", 
        pass: process.env.GMAIL_PASS || "shvi zcqa urou lmeo" 
    }
});

// Verify SMTP connection on server startup
transporter.verify((error, success) => {
    if (error) {
        console.error("❌ [EMAIL SMTP ERROR] Failed to connect to Gmail SMTP:", error.message);
    } else {
        console.log("✅ [EMAIL SMTP READY] Connected to Gmail SMTP successfully!");
    }
});

app.post("/sensor-error", async (req, res) => {
    const { sensor, message } = req.body;
    const mailOptions = {
        from: `"Smart Garden" <${process.env.GMAIL_USER || "tulatpham@gmail.com"}>`, 
        to: "sanglt3989@gmail.com",
        subject: `⚠️ LỖI PHẦN CỨNG: ${sensor || 'Không xác định'}`,
        html: `<div style="border: 2px solid #ff9800; padding: 20px;"><h2 style="color: #ff9800;">⚠️ CẢNH BÁO LỖI THIẾT BỊ</h2><p><b>Vị trí lỗi:</b> ${sensor}</p><p><b>Chi tiết:</b> <span style="color: #d32f2f;">${message}</span></p></div>`
    };

    try { 
        await transporter.sendMail(mailOptions); 
        console.log("📧 Email sensor error sent successfully!");
        res.status(200).send("OK"); 
    } catch (err) {
        console.error("❌ Failed to send sensor error email:", err);
        res.status(500).json({ error: "Failed to send email", details: err.message });
    }
});

app.post("/system-alarm", async (req, res) => {
    const { issueType, message } = req.body;
    const mailOptions = {
        from: `"Smart Garden" <${process.env.GMAIL_USER || "tulatpham@gmail.com"}>`, 
        to: "sanglt3989@gmail.com",
        subject: "🚨 BÁO ĐỘNG KHẨN CẤP: KHU VƯỜN THIẾU NƯỚC",
        html: `<div style="border: 2px solid #f44336; padding: 20px;"><h2 style="color: #f44336;">🚨 BÁO ĐỘNG HỆ THỐNG</h2><p><b>Phân loại:</b> ${issueType}</p><p><b>Tình trạng:</b> <span style="color: #d32f2f; font-weight: bold;">${message}</span></p></div>`
    };

    try { 
        await transporter.sendMail(mailOptions); 
        console.log("📧 Email alarm sent successfully!");
        res.status(200).send("OK"); 
    } catch (err) {
        console.error("❌ Failed to send system alarm email:", err);
        res.status(500).json({ error: "Failed to send email", details: err.message });
    }
});
