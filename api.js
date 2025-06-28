// api.js
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('whatsapp-web.js');

const app = express();
app.use(bodyParser.json());

const client = new Client();

client.on('qr', (qr) => {
    console.log('Scan this QR code:', qr);
});

client.on('ready', () => {
    console.log('WhatsApp API Bot is ready!');
});

// Endpoint untuk mengirim pesan
app.post('/send-message', async (req, res) => {
    const { groupId, message } = req.body;

    if (!groupId || !message) {
        return res.status(400).send({ error: 'groupId and message are required' });
    }

    try {
        await client.sendMessage(groupId, message);
        res.status(200).send({ success: true, message: 'Message sent successfully!' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).send({ error: 'Failed to send message' });
    }
});

// Mulai client WhatsApp dan server API
client.initialize();
app.listen(3000, () => {
    console.log('API server is running on http://localhost:3000');
});