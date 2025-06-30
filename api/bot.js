// bot.js
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
// const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Import database dari file terpisah
const db = require('../api/database');

// Inisialisasi Express dan Socket.IO
const app = express();
const server = http.createServer(app);

// Konfigurasi direktori
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOAD_DIR = path.join('/var/www/html/whatsapp-bot/download');

// Buat direktori jika belum ada
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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
            console.log(`Reconnect attempt ${reconnectAttempts}`)
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
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
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
        connectTimeoutMs: 60000, // Perpanjang timeout
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
            console.log('QR Code Generated');
            console.log('\n===== QR CODE =====');
            console.log('Scan QR Code di bawah ini:');

            // Pastikan qrcode sudah di-import
            require('qrcode-terminal').generate(qr, { small: true });

            console.log('\nCaranya:');
            console.log('1. Buka WhatsApp di HP');
            console.log('2. Pilih Setelan > Sambungkan Perangkat');
            console.log('3. Scan QR Code di atas');
            console.log('==================\n');

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
                    console.log('Device Logged Out, Reconnecting...');
                    break;
                case DisconnectReason.connectionReplaced:
                    console.log('Connection Replaced, Reconnecting...');
                    break;
                case DisconnectReason.connectionLost:
                    console.log('Connection Lost, Reconnecting...');
                    break;
                default:
                    console.log('Connection Closed. Reconnecting...', lastDisconnect?.error);
            }

            // Coba reconnect
            await connectToWhatsApp();
        }

        if (connection === 'open') {
            console.log('Koneksi Berhasil Terhubung');
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
                if (normalizedText === 'bantuan bot') {
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `🤖 Daftar Perintah Pemasukan Data:
• Category Makan Minum : makan harga | minum harga (ex: makan_nasgor 12rb, minum_jus 20rb)
• Category Sahabat Sebat : rokok harga (ex: rokok_liquid 35rb)
• Category Transport : maxim harga | gojek harga | grab harga | bensin harga (ex: gojek_kekantor 20rb, bensin 10rb)
• Category Entertaiment : internet harga (ex: ineternet_kuota 25rb, internet_viu 50rb)
• Category Komunikasi : kuota harga | pulsa harga (ex: pulsa 20rb, kuota 10rb)
• Category Listrik : token harga (ex: token_pln 20rb, token 10rb)
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

                // Pengeluaran Bulan Ini
                if (normalizedText === 'pengeluaran bulan ini') {
                    const monthExpenses = await getThisMonthExpenses();
                    const pesanPengeluaran = createExpenseMessage(
                        monthExpenses,
                        'Pengeluaran Bulan Ini'
                    );

                    await sock.sendMessage(message.key.remoteJid, { text: pesanPengeluaran });
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

                            await client.sendMessage(message.from, ringkasanPesan);
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
    return date.toLocaleDateString('id-ID', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
}

// Fungsi untuk mendapatkan pengeluaran berdasarkan rentang waktu
function getExpensesByDateRange(startDate, endDate) {
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
            resolve(rows);
        });
    });
}

// Fungsi untuk mendapatkan pengeluaran minggu ini
function getThisWeekExpenses() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Dapatkan hari pertama minggu ini (Senin)
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay() + 1);

    // Dapatkan hari terakhir minggu ini (Minggu)
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay()));

    return getExpensesByDateRange(
        startOfWeek.toISOString().split('T')[0],
        endOfWeek.toISOString().split('T')[0]
    );
}

// Fungsi untuk mendapatkan pengeluaran bulan ini
function getThisMonthExpenses() {
    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    return getExpensesByDateRange(
        firstDayOfMonth.toISOString().split('T')[0],
        lastDayOfMonth.toISOString().split('T')[0]
    );
}

// Fungsi untuk membuat pesan pengeluaran
function createExpenseMessage(expenses, title) {
    if (expenses.length === 0) {
        return `📊 ${title}\n\nBelum ada pengeluaran.`;
    }

    const totalPengeluaran = expenses.reduce((total, expense) => total + expense.price, 0);

    let pesanPengeluaran = `📊 ${title}\n\n`;

    // Kelompokkan berdasarkan kategori
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

    // Urutkan kategori berdasarkan total pengeluaran
    const sortedCategories = Object.entries(categoryTotals)
        .sort((a, b) => b[1].total - a[1].total);

    // Buat pesan dengan detail kategori
    sortedCategories.forEach(([category, data]) => {
        pesanPengeluaran += `• ${category}: ${data.total.toLocaleString('id-ID')} IDR ` +
            `(${data.count} transaksi)\n`;

        // Optional: Tampilkan detail item dalam kategori
        // data.items.forEach(item => {
        //     pesanPengeluaran += `  - ${item.name}: ${item.price.toLocaleString('id-ID')} IDR\n`;
        // });
    });

    pesanPengeluaran += `\n💰 Total Pengeluaran: ${totalPengeluaran.toLocaleString('id-ID')} IDR`;

    return pesanPengeluaran;
}

// Serve static files
app.use(express.static(PUBLIC_DIR));

// Route untuk halaman QR
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'qr.html'));
});

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
            console.log(`Browser found: ${browserPath}`);
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
app.get('/qr', (req, res) => {
    if (currentQRCode) {
        // Gunakan library qrcode untuk generate gambar
        const QRCode = require('qrcode');
        QRCode.toDataURL(currentQRCode, (err, url) => {
            if (err) {
                return res.status(500).send('Error generating QR');
            }
            res.send(`
                <html>
                    <body>
                        <h1>Scan QR Code</h1>
                        <img src="${url}" alt="QR Code"/>
                        <p>Scan dengan WhatsApp</p>
                    </body>
                </html>
            `);
        });
    } else {
        res.send('No QR Code available');
    }
});
// Koneksi Socket.IO
// Debugging tambahan
console.log('Initializing WhatsApp Client...');
// // Event untuk QR Code
// client.on('qr', (qr) => {
//     console.log('\n===== QR CODE =====');
//     console.log('Scan QR Code di bawah ini:');

//     // Tampilkan QR di terminal
//     qrcode.generate(qr, { small: true });

//     console.log('\nCaranya:');
//     console.log('1. Buka WhatsApp di HP');
//     console.log('2. Pilih Setelan > Sambungkan Perangkat');
//     console.log('3. Scan QR Code di atas');
//     console.log('==================\n');

//     currentQRCode = qr;
//     sendQRNotification(qr);
// });



// // Event autentikasi
// client.on('authenticated', (session) => {
//     console.log('✅ Autentikasi berhasil');
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
        const createdAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
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
        'internet': 'Entertaiment',
        'pulsa': 'Komunikasi',
        'kuota': 'Komunikasi'
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

            // Tambahkan data
            rows.forEach(exp => {
                worksheet.addRow({
                    created_at: exp.created_at,
                    name: exp.name,
                    category: exp.category,
                    price: exp.price
                });
                totalPengeluaran += exp.price;
            });

            // Tambahkan total
            worksheet.addRow({
                name: 'TOTAL PENGELUARAN',
                price: totalPengeluaran
            });

            // Styling
            worksheet.getRow(1).font = { bold: true };
            worksheet.columns.forEach(column => {
                column.alignment = { horizontal: 'left' };
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
    console.log(`Server berjalan di port ${PORT}`);

    try {
        const sock = await initializeWhatsApp();

        // Simpan socket global jika diperlukan
        global.sock = sock;
    } catch (error) {
        console.error('Gagal memulai koneksi WhatsApp:', error);
    }
});

// Buat direktori session jika belum ada
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir);
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