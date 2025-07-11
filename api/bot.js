// bot.js
const { Server } = require('socket.io');
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const qrcode = require('qrcode-terminal');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { format, formatInTimeZone } = require('date-fns-tz');
const { exec } = require('child_process');

// Import database dari file terpisah
const db = require('../api/database');

// Inisialisasi Express dan Socket.IO
const app = express();
const server = http.createServer(app);

const io = new Server(server); // Initialize Socket.IO with the server
// Configure directories
const PUBLIC_DIR = path.join(__dirname, '../public');
const DOWNLOAD_DIR = path.join(__dirname, '../download');
const LOGFILEPATH_DIR = path.join(__dirname, '../logs/server.log');

// Create required directories if they do not exist
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Create logs directory if it does not exist
const logsDirectory = path.dirname(LOGFILEPATH_DIR);
fs.mkdirSync(logsDirectory, { recursive: true }); // Ensure logs directory exists

// Check if the log file exists; if it's a directory, report an error
if (fs.existsSync(LOGFILEPATH_DIR)) {
    const stats = fs.lstatSync(LOGFILEPATH_DIR);
    if (stats.isDirectory()) {
        console.error(`A directory exists at log file path: ${LOGFILEPATH_DIR}. Please remove it.`);
        process.exit(1); // Exit the application as it cannot proceed
    }
} else {
    // Create the log file if it does not exist
    fs.writeFileSync(LOGFILEPATH_DIR, ''); // Create the log file as empty
}
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

async function initializeWhatsApp() {
    try {
        const sock = await connectToWhatsApp()
        reconnectAttempts = 0
        return sock
    } catch (error) {
        reconnectAttempts++

        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            logToClients(`Reconnect attempt ${reconnectAttempts}`)
            await new Promise(resolve => setTimeout(resolve, 5000))
            return initializeWhatsApp()
        } else {
            console.error('Max reconnect attempts reached')
            process.exit(1)
        }
    }
}

// Fungsi utama untuk koneksi WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    // Eksplisit definisikan crypto provider
    const cryptoProvider = {
        randomBytes: crypto.randomBytes,
        createHash: crypto.createHash,
        createHmac: crypto.createHmac
    };

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        crypto: cryptoProvider, // Gunakan provider crypto yang didefinisikan
        browser: ['WhatsApp Bot', 'Chrome', '20.0'],
        connectTimeoutMs: 10000, // Perpanjang timeout
        keepAliveIntervalMs: 30000, // Pertahankan koneksi
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        retryRequestDelayMs: 5000, // Delay retry
        defaultQueryTimeoutMs: undefined // Nonaktifkan timeout default
    })

    // Event listener untuk status koneksi
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logToClients('QR Code Generated');
            logToClients('\n===== QR CODE =====');
            logToClients('Scan QR Code di bawah ini:');

            // Pastikan qrcode sudah di-import
            require('qrcode-terminal').generate(qr, { small: true });

            logToClients('\nCaranya:');
            logToClients('1. Buka WhatsApp di HP');
            logToClients('2. Pilih Setelan > Sambungkan Perangkat');
            logToClients('3. Scan QR Code di atas');
            logToClients('==================\n');

            // Simpan QR Code jika ingin digunakan di route web
            currentQRCode = qr;

            // Kirim notifikasi QR jika diperlukan
            try {
                await sendQRNotification(qr);
            } catch (error) {
                console.error('Gagal mengirim notifikasi QR:', error);
            }
        }

        if (connection === 'close') {
            const status = lastDisconnect?.error?.output?.statusCode;

            // Gunakan switch untuk lebih rapi
            switch (status) {
                case DisconnectReason.loggedOut:
                    logToClients('Device Logged Out, Reconnecting...');
                    break;
                case DisconnectReason.connectionReplaced:
                    logToClients('Connection Replaced, Reconnecting...');
                    break;
                case DisconnectReason.connectionLost:
                    logToClients('Connection Lost, Reconnecting...');
                    break;
                default:
                    logToClients('Connection Closed. Reconnecting...', lastDisconnect?.error);
            }

            // Coba reconnect
            await connectToWhatsApp();
        }

        if (connection === 'open') {
            logToClients('Koneksi Berhasil Terhubung');
        }
    });
    //nsial
    sock.ev.on('creds.update', saveCreds);

    // Event listener untuk pesan
    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];

        if (!message.key.fromMe && m.type === 'notify') {
            const senderPhone = message.key.participant || message.key.remoteJid;
            const senderName = message.pushName || 'Tanpa Nama';
            const text = message.message?.conversation ||
                message.message?.extendedTextMessage?.text || '';

            // Normalisasi pesan
            const normalizedText = text.toLowerCase().trim();
            const parts = normalizedText.split(/\s+/);

            // Logika pemrosesan pesan mirip dengan versi sebelumnya
            if (message.key.remoteJid.includes('@g.us')) {
                // Proses pesan group
                if (parts.length === 2) {
                    const name = parts[0];
                    try {
                        const price = parsePrice(parts[1]);

                        if (!isNaN(price) && price > 0) {
                            const category = determineCategory(name);

                            await addExpense(name, category, price);

                            await sock.sendMessage(message.key.remoteJid, {
                                text: `✅ Pengeluaran dicatat:\n` +
                                    `📝 Item: ${name}\n` +
                                    `📊 Kategori: ${category}\n` +
                                    `💰 Harga: ${price.toLocaleString('id-ID')} IDR`
                            });
                        }
                    } catch (error) {
                        console.error('Gagal mencatat pengeluaran:', error);
                    }
                }
                if (normalizedText === 'dastrevas') {
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `🤖 Daftar Perintah Pengeluaran:
• bantuan bot
• bantuan pengeluaran

Kirim salah satu perintah di atas untuk melihat caranya.`
                    });
                }
                if (normalizedText === 'bantuan bot') {
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `🤖 Daftar Perintah Pemasukan Data:
• Category Makan Minum : makan harga | minum harga (ex: makan_nasgor 12rb, minum_jus 20rb)
• Category Sahabat Sebat : rokok harga (ex: rokok_liquid 35rb)
• Category Transport : maxim harga | gojek harga | grab harga | bensin harga (ex: gojek_kekantor 20rb, bensin 10rb)
• Category Komunikasi : kuota harga | pulsa harga | internet harga (ex: pulsa 20rb, kuota 10rb)
• Category Listrik : token harga (ex: token_pln 20rb, token 10rb)
• Category Fashion : fashion harga (ex: fashion_baju 20rb)
• Category Grocery : grocery harga (ex: grocery_tisu 20rb)
• Category Anak : anak harga (ex: anak_makan 20rb, anak_pasir 10rb)
• Category Lain-lain : apapun harga (ex: sumbangan 20rb, sedekah 10rb)

Kirim salah satu perintah di atas untuk mengirim pengeluaran.`
                    });
                }
                if (normalizedText === 'bantuan pengeluaran') {
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `🤖 Daftar Perintah Pengeluaran:
• download pengeluaran
• pengeluaran hari ini
• pengeluaran minggu ini
• pengeluaran bulan ini
• detail pengeluaran hari ini
• detail pengeluaran minggu ini
• hapus pengeluaran
• ringkasan

Kirim salah satu perintah di atas untuk melihat detail pengeluaran.`
                    });
                }
                // Perintah download Excel
                if (normalizedText === 'download pengeluaran') {
                    try {
                        const fileName = await generateExcel();
                        const downloadUrl = `https://dastrevas.com/download/${fileName}`;

                        await sock.sendMessage(message.key.remoteJid, {
                            text: `📊 Laporan Pengeluaran\n\n` +
                                `✅ File Excel telah dibuat!\n` +
                                `🔗 Unduh di: ${downloadUrl}`
                        });
                    } catch (error) {
                        console.error('Gagal membuat Excel:', error);
                    }
                }
                // Pengeluaran Hari Ini (sudah ada sebelumnya)
                if (normalizedText === 'pengeluaran hari ini') {
                    const todayExpenses = await getTodayExpenses();
                    const pesanPengeluaran = createExpenseMessage(
                        todayExpenses,
                        `Pengeluaran Hari Ini (${formatDate(new Date())})`
                    );

                    await sock.sendMessage(message.key.remoteJid, { text: pesanPengeluaran });
                }

                // Pengeluaran Minggu Ini
                if (normalizedText === 'pengeluaran minggu ini') {
                    const weekExpenses = await getThisWeekExpenses();
                    const pesanPengeluaran = createExpenseMessage(
                        weekExpenses,
                        'Pengeluaran Minggu Ini'
                    );

                    await sock.sendMessage(message.key.remoteJid, { text: pesanPengeluaran });
                }
                // Command to request deletion of today's expenses
                if (normalizedText === 'hapus pengeluaran' || normalizedText === 'undo') {
                    const todayExpenses = await getTodayExpenses();

                    if (todayExpenses.length === 0) {
                        await sock.sendMessage(message.key.remoteJid, {
                            text: '📊 Belum ada pengeluaran hari ini.'
                        });
                        return;
                    }

                    // Create list to display to user
                    let expenseListMessage = '📊 Pengeluaran Hari Ini:\n';
                    todayExpenses.forEach((expense, index) => {
                        expenseListMessage += `[${index + 1}] ${expense.name} ${expense.price.toLocaleString('id-ID')} IDR\n`;
                    });

                    await sock.sendMessage(message.key.remoteJid, {
                        text: expenseListMessage + 'Silakan pilih nomor pengeluaran yang ingin dihapus.'
                    });
                    return; // Wait for the user's selection
                }

                // Pengeluaran Bulan Ini
                if (normalizedText === 'pengeluaran bulan ini') {
                    const monthExpenses = await getThisMonthExpenses();
                    const pesanPengeluaran = createExpenseMessage(
                        monthExpenses,
                        'Pengeluaran Bulan Ini'
                    );

                    await sock.sendMessage(message.key.remoteJid, { text: pesanPengeluaran });
                }
                // Handle the user's selection for deletion
                if (parts.length === 1 && !isNaN(parts[0])) { // if user sends only a number
                    const selectedIndex = parseInt(parts[0]) - 1; // Convert to zero-based index
                    const todayExpenses = await getTodayExpenses(); // Fetch entries again

                    if (todayExpenses[selectedIndex]) {
                        const selectedExpense = todayExpenses[selectedIndex];

                        try {
                            // Delete the selected expense from the database
                            await deleteExpense(selectedExpense.name, selectedExpense.category, selectedExpense.price);

                            await sock.sendMessage(message.key.remoteJid, {
                                text: `✅ Pengeluaran berhasil dihapus:\n📝 Item: ${selectedExpense.name}\n💰 Harga: ${selectedExpense.price.toLocaleString('id-ID')} IDR`
                            });
                        } catch (error) {
                            console.error('Gagal menghapus pengeluaran:', error);
                            await sock.sendMessage(message.key.remoteJid, {
                                text: '❌ Gagal menghapus pengeluaran. Coba lagi nanti.'
                            });
                        }
                    } else {
                        await sock.sendMessage(message.key.remoteJid, {
                            text: '❌ Nomor yang Anda pilih tidak valid.'
                        });
                    }
                }
                if (normalizedText === 'detail pengeluaran hari ini') {
                    const todayExpenses = await getTodayExpenses(); // Fetch today's expenses
                    const detailMessage = createDetailedExpenseMessage(todayExpenses, `Detail Pengeluaran Hari Ini (${formatDate(new Date())})`);

                    await sock.sendMessage(message.key.remoteJid, { text: detailMessage });
                }

                if (normalizedText === 'detail pengeluaran minggu ini') {
                    const weekExpenses = await getThisWeekExpenses(); // Fetch this week's expenses
                    const detailMessage = createDetailedExpenseMessage(weekExpenses, `Detail Pengeluaran Minggu Ini`);

                    await sock.sendMessage(message.key.remoteJid, { text: detailMessage });
                }
                // Perintah ringkasan pengeluaran
                if (text.startsWith('ringkasan')) {
                    try {
                        const query = `
                    SELECT category, 
                           SUM(price) as total_pengeluaran, 
                           COUNT(*) as jumlah_transaksi 
                    FROM expenses 
                    GROUP BY category 
                    ORDER BY total_pengeluaran DESC
                `;

                        db.all(query, [], async (err, rows) => {
                            if (err) {
                                console.error('Gagal mengambil ringkasan:', err);
                                return;
                            }

                            let ringkasanPesan = "📊 Ringkasan Pengeluaran:\n\n";
                            let totalPengeluaran = 0;

                            rows.forEach(row => {
                                ringkasanPesan +=
                                    `• ${row.category}: ${row.total_pengeluaran.toLocaleString('id-ID')} IDR ` +
                                    `(${row.jumlah_transaksi} transaksi)\n`;
                                totalPengeluaran += row.total_pengeluaran;
                            });

                            ringkasanPesan += `\n💰 Total Pengeluaran: ${totalPengeluaran.toLocaleString('id-ID')} IDR`;

                            await sock.sendMessage(message.from, ringkasanPesan);
                        });
                    } catch (error) {
                        console.error('Gagal membuat ringkasan:', error);
                    }
                }
            } else {
                if (parts.length === 2) {
                    const name = parts[0];
                    try {
                        const price = parsePrice(parts[1]);

                        if (!isNaN(price) && price > 0) {
                            await addExpense(name, 'Lain-lain', price);
                            await message.reply(
                                `✅ Pengeluaran pribadi dicatat:\n` +
                                `📝 Item: ${name}\n` +
                                `💰 Harga: ${price.toLocaleString('id-ID')} IDR`
                            );
                        }
                    } catch (error) {
                        console.error('Gagal mencatat pengeluaran pribadi:', error);
                    }
                }
            }
        }
    });

    return sock;
}
// Fungsi untuk mendapatkan tanggal dalam format yang sesuai
function formatDate(date) {
    return date.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', // Set timezone
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',          // Include hours
        minute: '2-digit',        // Include minutes
        hour12: false             // 24-hour format
    });
}
async function getTodayExpenses() {
    const today = new Date();
    const startDate = today.toISOString().split('T')[0]; // YYYY-MM-DD
    const endDate = today.toISOString().split('T')[0]; // YYYY-MM-DD

    return getExpensesByDateRange(startDate, endDate);
}

async function getThisMonthExpenses() {
    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    return getExpensesByDateRange(
        firstDayOfMonth.toISOString().split('T')[0], // Start Date
        lastDayOfMonth.toISOString().split('T')[0]   // End Date
    );
}

// Function to delete the selected expense
function deleteExpense(name, category, price) {
    return new Promise((resolve, reject) => {
        const sql = `DELETE FROM expenses WHERE name = ? AND category = ? AND price = ?`;
        db.run(sql, [name, category, price], function (err) {
            if (err) {
                return reject(err);
            }
            resolve(this.changes); // Return the number of rows deleted
        });
    });
}
function createDetailedExpenseMessage(expenses, title) {
    if (expenses.length === 0) {
        return `📊 ${title}\n\nBelum ada pengeluaran.`;
    }

    let detailMessage = `📊 ${title}\n\n`;

    expenses.forEach(exp => {
        const createdAt = new Date(exp.created_at);
        const formattedTime = formatDate(createdAt); // Now includes time

        detailMessage += `📝 Item: ${exp.name}\n` +
                         `💰 Harga: ${exp.price.toLocaleString('id-ID')} IDR\n` +
                         `⏰ Waktu: ${formattedTime}\n\n`;
    });

    return detailMessage;
}
function getExpensesByDateRange(startDate, endDate) {
    logToClients('Querying expenses from', startDate, 'to', endDate); // Log dates for debugging
    return new Promise((resolve, reject) => {
        const query = `
            SELECT name, category, price, created_at
            FROM expenses 
            WHERE date(created_at) BETWEEN date(?) AND date(?)
            ORDER BY price DESC
        `;

        db.all(query, [startDate, endDate], (err, rows) => {
            if (err) {
                console.error('Gagal mengambil pengeluaran:', err);
                return reject(err);
            }
            logToClients('Expenses found:', rows); // Log result for debugging
            resolve(rows);
        });
    });
}

async function getThisWeekExpenses() {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Set time to the start of the day

    // Get the first day of the week (Monday)
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - (today.getDay() + 6) % 7); // Adjust so Monday is the first day of the week

    // Get the last day of the week (Sunday)
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay())); // Adjust so Sunday is the last day of the week

    return getExpensesByDateRange(
        startOfWeek.toISOString().split('T')[0], // Start Date
        endOfWeek.toISOString().split('T')[0]    // End Date
    );
}

// Function to create the expense message
function createExpenseMessage(expenses, title) {
    if (expenses.length === 0) {
        return `📊 ${title}\n\nBelum ada pengeluaran.`;
    }

    // Calculate total spending
    const totalPengeluaran = expenses.reduce((total, expense) => total + expense.price, 0);
    let pesanPengeluaran = `📊 ${title}\n\n`;

    // Group expenses by category
    const categoryTotals = {};
    expenses.forEach(expense => {
        if (!categoryTotals[expense.category]) {
            categoryTotals[expense.category] = {
                total: 0,
                count: 0,
                items: []
            };
        }
        categoryTotals[expense.category].total += expense.price;
        categoryTotals[expense.category].count++;
        categoryTotals[expense.category].items.push(expense);
    });

    // Sort categories by total spending
    const sortedCategories = Object.entries(categoryTotals)
        .sort((a, b) => b[1].total - a[1].total);

    // Construct message with category details
    sortedCategories.forEach(([category, data]) => {
        pesanPengeluaran += `• ${category}: ${data.total.toLocaleString('id-ID')} IDR ` +
            `(${data.count} transaksi)\n`;
    });

    pesanPengeluaran += `\n💰 Total Pengeluaran: ${totalPengeluaran.toLocaleString('id-ID')} IDR`;
    return pesanPengeluaran;
}

// Serve static files
app.use(express.static(PUBLIC_DIR));

// Route untuk download Excel
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, filename);

    // Cek apakah file ada
    if (fs.existsSync(filePath)) {
        res.download(filePath, filename, (err) => {
            if (err) {
                res.status(500).send('Tidak dapat mengunduh file');
            }

            // Opsional: Hapus file setelah didownload
            // fs.unlinkSync(filePath);
        });
    } else {
        res.status(404).send('File tidak ditemukan');
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    // Optional: Restart proses
    process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
// Lokasi browser yang mungkin
const possibleBrowserPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
];

// Fungsi untuk menemukan browser
function findBrowserPath() {
    for (const browserPath of possibleBrowserPaths) {
        if (fs.existsSync(browserPath)) {
            logToClients(`Browser found: ${browserPath}`);
            return browserPath;
        }
    }
    console.error('No browser found!');
    return null;
}

// // Inisialisasi client WhatsApp
// const client = new Client({
//     puppeteer: {
//         executablePath: findBrowserPath(),
//         args: [
//             '--no-sandbox',
//             '--disable-setuid-sandbox',
//             '--disable-gpu',
//             '--disable-software-rasterizer',
//             '--disable-dev-shm-usage'
//         ]
//     },
//     authStrategy: new LocalAuth({
//         dataPath: path.join(__dirname, 'session')
//     }),
//     webVersion: '2.2410.1',
//     webVersionCache: {
//         type: 'none'
//     }
// });

let currentQRCode = null;

// Misalnya menggunakan Telegram atau Discord
async function sendQRNotification(qr) {
    const telegramBotToken = '5006730939:AAGBZhLv31EWPAVKIADxxI_7wwnRhzqo5DY';
    const chatId = '1546898379';

    try {
        const response = await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            chat_id: chatId,
            text: `QR Code Baru Tersedia! Silakan scan di: https://https://whatsapp-bot-orpin.vercel.app/qr`
        });
    } catch (error) {
        console.error('Gagal mengirim notifikasi', error);
    }
}

// Tambahkan route untuk QR
app.get('/', (req, res) => {
    if (currentQRCode) {
        const QRCode = require('qrcode');
        QRCode.toDataURL(currentQRCode, (err, url) => {
            if (err) {
                return res.status(500).send('Error generating QR');
            }
            res.send(`
                <html>
                    <head>
                        <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
                        <title>Scan QR Code</title>
                        <style>
                            #logContainer {
                                height: 300px;
                                overflow-y: scroll;
                                border: 1px solid #ccc;
                                padding: 10px;
                                background: #f9f9f9;
                            }
                        </style>
                    </head>
                    <body class="bg-light">
                        <div class="container mt-5">
                            <h1 class="text-center">Scan QR Code</h1>
                            <div class="text-center">
                                <img src="${url}" alt="QR Code" class="img-fluid" style="max-width: 300px;"/>
                                <p>Scan dengan WhatsApp</p>
                                <p>------------Atau------------</p>
                                <form action="/reset" method="get">
                                    <button type="submit" class="btn btn-danger">Reset Cache and Restart</button>
                                </form>
                                <p>------------logs------------</p>
                                <div id="logContainer"></div>
                            </div>
                        </div>

                        <script src="/socket.io/socket.io.js"></script>
                        <script>
                            const socket = io();
                            const logContainer = document.getElementById('logContainer');

                            // Fetch existing logs on page load
                            fetch('/logs')
                                .then(response => response.json())
                                .then(logs => {
                                    logs.forEach(log => {
                                        const logElement = document.createElement('div');
                                        logElement.textContent = log;
                                        logContainer.appendChild(logElement);
                                    });
                                    // Auto-scroll to the bottom after loading existing logs
                                    logContainer.scrollTop = logContainer.scrollHeight;
                                });

                            // Listen for new log messages from the server
                            socket.on('log', function(message) {
                                const logElement = document.createElement('div');
                                logElement.textContent = message;
                                logContainer.appendChild(logElement);
                                // Auto-scroll to the bottom when a new log is added
                                logContainer.scrollTop = logContainer.scrollHeight;
                            });
                        </script>
                    </body>
                </html>
            `);
        });
    } else {
        res.send(`
            <html>
                <head>
                    <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
                    <title>Error QR Code</title>
                    <style>
                        #logContainer {
                            height: 300px;
                            overflow-y: scroll;
                            border: 1px solid #ccc;
                            padding: 10px;
                            background: #f9f9f9;
                        }
                    </style>
                </head>
                <body class="bg-light">
                    <div class="container mt-5">
                        <div class="text-center">
                            <p>NO QR CODE AVAILABLE, TRY RESET CACHE</p>
                            <div id="logContainer"></div>
                            <form action="/reset" method="get">
                                <button type="submit" class="btn btn-danger">Reset Cache and Restart</button>
                            </form>
                        </div>
                    </div>

                    <script src="/socket.io/socket.io.js"></script>
                    <script>
                        const socket = io();
                        const logContainer = document.getElementById('logContainer');

                        // Fetch existing logs on page load
                        fetch('/logs')
                            .then(response => response.json())
                            .then(logs => {
                                logs.forEach(log => {
                                    const logElement = document.createElement('div');
                                    logElement.textContent = log;
                                    logContainer.appendChild(logElement);
                                });
                                // Auto-scroll to the bottom after loading existing logs
                                logContainer.scrollTop = logContainer.scrollHeight;
                            });

                        // Listen for new log messages from the server
                        socket.on('log', function(message) {
                            const logElement = document.createElement('div');
                            logElement.textContent = message;
                            logContainer.appendChild(logElement);
                            // Auto-scroll to the bottom when a new log is added
                            logContainer.scrollTop = logContainer.scrollHeight;
                        });
                    </script>
                </body>
            </html>
        `);
    }
});

// Main route for reset functionality
app.get('/reset', async (req, res) => {
    let message = '';
    let success = true; // Variable to track success/failure

    try {
        // First attempt to delete the directories
        deleteDirectory(sessionDir);
        deleteDirectory(PUBLIC_DIR);
        message = 'Cache has been cleared successfully!';
    } catch (error) {
        success = false; // Update success status if an error occurs
        message = 'There was a problem clearing the cache. Trying with sudo...' + error;
        console.error(error); // Log the error for debugging

        // Attempt to delete using sudo as a fallback
        try {
            await deleteDirectoryWithSudo(sessionDir);
            await deleteDirectoryWithSudo(PUBLIC_DIR);
            message = 'Cache has been cleared successfully using sudo!';
            success = true; // Mark success if sudo deletion worked
        } catch (sudoError) {
            success = false; // Update success status if sudo also fails
            message = 'Failed to clear cache with sudo as well. Please check permissions.';
            console.error(sudoError); // Log the sudo error
        }
    }

    // Render the response with the success or failure message
    res.send(`
        <html>
            <head>
                <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
                <title>Reset Cache</title>
            </head>
            <body class="bg-light">
                <div class="container mt-5">
                    <h1 class="text-center">${success ? 'Success!' : 'Error!'}</h1>
                    <p class="text-center">${message}</p>
                    <div class="text-center">
                        <img src="${success ? 'https://img.icons8.com/emoji/96/okay-hand-emoji.png' : 'https://img.icons8.com/emoji/96/cross-mark-emoji.png'}" alt="${success ? 'Success' : 'Error'}" style="max-width: 100px;"/>
                    </div>
                    <p class="text-center">Redirecting you back to the home page shortly...</p>
                    
                    <script>
                        setTimeout(() => { window.location.href = '/'; }, 3000); // Redirect after 3 seconds
                    </script>
                </div>
            </body>
        </html>
    `);
});


// Function to delete a directory
const deleteDirectory = (dirPath) => {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true }); // changing rmdir to rm
        logToClients(`Deleted directory: ${dirPath}`);
    } else {
        logToClients(`Directory not found: ${dirPath}`);
    }
};

// Function to delete a directory using sudo
const deleteDirectoryWithSudo = (dirPath) => {
    return new Promise((resolve, reject) => {
        exec(`sudo rm -rf "${dirPath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error deleting directory with sudo: ${stderr}`);
                return reject(error);
            }
            resolve(stdout);
        });
    });
};
// Koneksi Socket.IO
// Debugging tambahan
logToClients('Initializing WhatsApp Client...');
// // Event untuk QR Code
// client.on('qr', (qr) => {
//     logToClients('\n===== QR CODE =====');
//     logToClients('Scan QR Code di bawah ini:');

//     // Tampilkan QR di terminal
//     qrcode.generate(qr, { small: true });

//     logToClients('\nCaranya:');
//     logToClients('1. Buka WhatsApp di HP');
//     logToClients('2. Pilih Setelan > Sambungkan Perangkat');
//     logToClients('3. Scan QR Code di atas');
//     logToClients('==================\n');

//     currentQRCode = qr;
//     sendQRNotification(qr);
// });



// // Event autentikasi
// client.on('authenticated', (session) => {
//     logToClients('✅ Autentikasi berhasil');
// });

// // Event error
// client.on('auth_failure', (msg) => {
//     console.error('❌ Autentikasi Gagal:', msg);
// });

// Fungsi Utilitas

// Fungsi untuk menambah pengeluaran
function addExpense(name, category, price) {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT INTO expenses (name, category, price, created_at) VALUES (?, ?, ?, ?)';
        const createdAt = new Date().toISOString();  // Store date in ISO format
        db.run(sql, [name, category, price, createdAt], function (err) {
            if (err) {
                return reject(err);
            }
            resolve(this.lastID);
        });
    });
}

// Fungsi untuk menambah pengirim
function addSender(name, phone) {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT OR IGNORE INTO senders (name, phone, created_at) VALUES (?, ?, ?)';
        const createdAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        db.run(sql, [name, phone, createdAt], function (err) {
            if (err) {
                return reject(err);
            }
            resolve(this.lastID);
        });
    });
}

// Fungsi parsing harga
function parsePrice(priceString) {
    priceString = priceString.replace(/\s/g, '');
    let price = parseFloat(priceString.replace(/[^\d]/g, ''));
    if (priceString.includes('rb')) {
        price *= 1000;
    } else if (priceString.includes('k')) {
        price *= 1000;
    }
    return Math.round(price);
}

// Fungsi untuk menentukan kategori
function determineCategory(name) {
    const categoryMap = {
        'makan': 'Makanan',
        'minum': 'Makanan',
        'gojek': 'Transport',
        'grab': 'Transport',
        'maxim': 'Transport',
        'bensin': 'Transport',
        'token': 'Token Listrik',
        'listrik': 'Token Listrik',
        'rokok': 'Sahabat Sebat',
        'internet': 'Komunikasi',
        'pulsa': 'Komunikasi',
        'kuota': 'Komunikasi',
        'grocery': 'Grocery Sehari hari',
        'fashion': 'Fashion dan Cosmetic',
        'anak': 'Kebutuhan Anak'
    };

    for (const [keyword, category] of Object.entries(categoryMap)) {
        if (name.toLowerCase().includes(keyword)) return category;
    }

    return 'Lain-lain';
}

// Fungsi generate Excel
async function generateExcel() {
    const fileName = `Pengeluaran_${Date.now()}.xlsx`;
    const filePath = path.join(DOWNLOAD_DIR, fileName);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pengeluaran');

    // Setup worksheet
    worksheet.columns = [
        { header: 'Tanggal', key: 'created_at', width: 25 },
        { header: 'Nama', key: 'name', width: 30 },
        { header: 'Kategori', key: 'category', width: 20 },
        { header: 'Harga', key: 'price', width: 15 }
    ];

    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM expenses ORDER BY created_at DESC', [], async (err, rows) => {
            if (err) {
                return reject(err);
            }

            let totalPengeluaran = 0;

            // Tambahkan data dengan konversi waktu
            rows.forEach(exp => {
                const utcDate = new Date(exp.created_at); // ubah dari string ke objek Date

                // Cek apakah utcDate valid
                if (isNaN(utcDate.getTime())) {
                    console.error(`Invalid date found for expense: ${exp.created_at}`);
                    return; // Jika tanggal tidak valid, lewati row ini
                }

                // Format tanggal ke zona waktu Jakarta
                const jakartaDate = formatInTimeZone(utcDate, 'Asia/Jakarta', 'PPPPpp');

                // Tambah row ke worksheet
                worksheet.addRow({
                    created_at: jakartaDate,  // Ganti tanggal dengan yang sudah dikonversi
                    name: exp.name,
                    category: exp.category,
                    price: exp.price
                });
                totalPengeluaran += exp.price; // Tambahkan ke total pengeluaran
            });

            // Tambahkan total pengeluaran sebagai baris baru
            worksheet.addRow({
                name: 'TOTAL PENGELUARAN',
                price: totalPengeluaran // Menggunakan total
            });

            // Styling
            worksheet.getRow(1).font = { bold: true }; // Bold pada header
            worksheet.columns.forEach(column => {
                column.alignment = { horizontal: 'left' }; // Rata kiri untuk semua kolom
            });

            // Tulis file
            await workbook.xlsx.writeFile(filePath);

            // Resolve dengan nama file untuk membuat URL
            resolve(fileName);
        });
    });
}

// // Event listener untuk pesan
// client.on('message', async message => {
//     // Hindari memproses pesan dari status atau sistem
//     if (message.isStatus) return;

//     const senderPhone = message.from;
//     const senderName = message.sender.pushname || 'Tanpa Nama';

//     // Simpan pengirim ke database
//     try {
//         await addSender(senderName, senderPhone);
//     } catch (error) {
//         console.error('Gagal menyimpan pengirim:', error);
//     }

//     // Normalisasi pesan
//     const text = message.body.toLowerCase().trim();
//     const parts = text.split(/\s+/);

//     // Proses untuk pesan di grup
//     if (message.from.includes('@g.us')) {
//         // Cek format: nama_barang harga
//         if (parts.length === 2) {
//             const name = parts[0];
//             try {
//                 const price = parsePrice(parts[1]);

//                 if (!isNaN(price) && price > 0) {
//                     const category = determineCategory(name);

//                     // Tambah pengeluaran
//                     await addExpense(name, category, price);

//                     // Kirim konfirmasi
//                     await client.sendMessage(message.from,
//                         `✅ Pengeluaran dicatat:\n` +
//                         `📝 Item: ${name}\n` +
//                         `📊 Kategori: ${category}\n` +
//                         `💰 Harga: ${price.toLocaleString('id-ID')} IDR\n\n` +
//                         `💡 Tips: Hemat pangkal kaya!`
//                     );
//                 }
//             } catch (error) {
//                 console.error('Gagal mencatat pengeluaran:', error);
//             }
//         }

//         // Perintah download Excel
//         // Dalam event listener
//         if (text === 'download pengeluaran') {
//             try {
//                 const fileName = await generateExcel();

//                 // Gunakan URL deployment Vercel Anda
//                 const downloadUrl = `https://your-vercel-domain.vercel.app/download/${fileName}`;

//                 await client.sendMessage(message.from,
//                     `📊 Laporan Pengeluaran\n\n` +
//                     `✅ File Excel telah dibuat!\n` +
//                     `🔗 Unduh di: ${downloadUrl}\n\n` +
//                     `💡 Link aktif dalam 1 jam`
//                 );
//             } catch (error) {
//                 console.error('Gagal membuat Excel:', error);
//                 await client.sendMessage(message.from,
//                     '❌ Ups! Gagal membuat laporan. Coba lagi nanti.'
//                 );
//             }
//         }

//         // Perintah ringkasan pengeluaran
//         if (text.startsWith('ringkasan')) {
//             try {
//                 const query = `
//                     SELECT category, 
//                            SUM(price) as total_pengeluaran, 
//                            COUNT(*) as jumlah_transaksi 
//                     FROM expenses 
//                     GROUP BY category 
//                     ORDER BY total_pengeluaran DESC
//                 `;

//                 db.all(query, [], async (err, rows) => {
//                     if (err) {
//                         console.error('Gagal mengambil ringkasan:', err);
//                         return;
//                     }

//                     let ringkasanPesan = "📊 Ringkasan Pengeluaran:\n\n";
//                     let totalPengeluaran = 0;

//                     rows.forEach(row => {
//                         ringkasanPesan +=
//                             `• ${row.category}: ${row.total_pengeluaran.toLocaleString('id-ID')} IDR ` +
//                             `(${row.jumlah_transaksi} transaksi)\n`;
//                         totalPengeluaran += row.total_pengeluaran;
//                     });

//                     ringkasanPesan += `\n💰 Total Pengeluaran: ${totalPengeluaran.toLocaleString('id-ID')} IDR`;

//                     await client.sendMessage(message.from, ringkasanPesan);
//                 });
//             } catch (error) {
//                 console.error('Gagal membuat ringkasan:', error);
//             }
//         }
//     }
//     // Proses pesan pribadi
//     else {
//         if (parts.length === 2) {
//             const name = parts[0];
//             try {
//                 const price = parsePrice(parts[1]);

//                 if (!isNaN(price) && price > 0) {
//                     await addExpense(name, 'Lain-lain', price);
//                     await message.reply(
//                         `✅ Pengeluaran pribadi dicatat:\n` +
//                         `📝 Item: ${name}\n` +
//                         `💰 Harga: ${price.toLocaleString('id-ID')} IDR`
//                     );
//                 }
//             } catch (error) {
//                 console.error('Gagal mencatat pengeluaran pribadi:', error);
//             }
//         }
//     }
// });

// Jalankan server
// Jalankan server dan koneksi WhatsApp
const PORT = process.env.PORT || 1234;
server.listen(PORT, async () => {
    logToClients(`Server berjalan di port ${PORT}`);

    try {
        const sock = await initializeWhatsApp();

        // Simpan socket global jika diperlukan
        global.sock = sock;
    } catch (error) {
        console.error('Gagal memulai koneksi WhatsApp:', error);
    }
});

// Buat direktori session jika belum ada
const sessionDir = path.join(__dirname, '../session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir);
}
// Route to fetch logs
app.get('/logs', (req, res) => {
    fs.readFile(LOGFILEPATH_DIR, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading log file');
        }
        res.send(data.split('\n').filter(Boolean)); // Split logs by line and filter empty lines
    });
});
// Emit logs to connected clients and save to file
function logToClients(message) {
    console.log(message); // Log to console

    // Append the log message to the log file
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOGFILEPATH_DIR, `${timestamp} - ${message}\n`, 'utf8');

    io.emit('log', message); // Emit log message to clients
}
// Inisialisasi client WhatsApp
//client.initialize();

// Inisialisasi client WhatsApp

// Tangani exit
process.on('SIGINT', async () => {
    if (global.sock) {
        await global.sock.logout();
    }
    process.exit();
});