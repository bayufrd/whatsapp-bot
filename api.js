// api.js
const express = require('express');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(bodyParser.json());

// Konfigurasi client dengan opsi tambahan
const client = new Client({
    authStrategy: new LocalAuth(), // Simpan sesi otentikasi
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--remote-debugging-port=9222'
        ]
    }
});

// Event handler QR Code
client.on('qr', (qr) => {
    console.log('QR Code received');
    qrcode.generate(qr, { small: true }); // Tampilkan QR di terminal
});

// Event saat client siap
client.on('ready', () => {
    console.log('WhatsApp API Bot is ready!');
});

// Event autentikasi berhasil
client.on('authenticated', (session) => {
    console.log('Authenticated successfully');
});

// Event kegagalan autentikasi
client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
});

// Event terputus
client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
});

// Endpoint untuk mengirim pesan
app.post('/send-message', async (req, res) => {
    const { groupId, message } = req.body;

    if (!groupId || !message) {
        return res.status(400).send({ error: 'groupId and message are required' });
    }

    try {
        // Cek apakah client sudah siap
        if (!client.isReady) {
            return res.status(503).send({ error: 'WhatsApp client is not ready' });
        }

        await client.sendMessage(groupId, message);
        res.status(200).send({ success: true, message: 'Message sent successfully!' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).send({ error: 'Failed to send message', details: error.message });
    }
});

// Endpoint untuk memeriksa status client
app.get('/client-status', (req, res) => {
    res.status(200).send({ 
        isReady: client.isReady,
        status: client.isReady ? 'Connected' : 'Disconnected'
    });
});

// Inisialisasi client WhatsApp
client.initialize();

// Mulai server API
const PORT = process.env.PORT || 1234;
app.listen(PORT, () => {
    console.log(`API server is running on http://localhost:${PORT}`);
});