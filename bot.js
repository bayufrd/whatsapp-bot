// bot.js
const express = require('express');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// Import database dari file terpisah
const db = require('./database');

// Inisialisasi Express dan Socket.IO
const app = express();
const server = http.createServer(app);

// Konfigurasi direktori
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOAD_DIR = path.join('/var/www/html/whatsapp-bot/download');

// Buat direktori jika belum ada
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

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

// Inisialisasi client WhatsApp
const client = new Client({
    puppeteer: {
        executablePath: findBrowserPath(),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-dev-shm-usage'
        ]
    },
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, 'session')
    }),
    webVersion: '2.2410.1',
    webVersionCache: {
        type: 'none'
    }
});

// Koneksi Socket.IO
// Debugging tambahan
console.log('Initializing WhatsApp Client...');
// Event untuk QR Code
client.on('qr', (qr) => {
    console.log('\n===== QR CODE =====');
    console.log('Scan QR Code di bawah ini:');

    // Tampilkan QR di terminal
    qrcode.generate(qr, { small: true });

    console.log('\nCaranya:');
    console.log('1. Buka WhatsApp di HP');
    console.log('2. Pilih Setelan > Sambungkan Perangkat');
    console.log('3. Scan QR Code di atas');
    console.log('==================\n');

});



// Event autentikasi
client.on('authenticated', (session) => {
    console.log('✅ Autentikasi berhasil');
});

// Event error
client.on('auth_failure', (msg) => {
    console.error('❌ Autentikasi Gagal:', msg);
});

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

// Event listener untuk pesan
client.on('message', async message => {
    // Hindari memproses pesan dari status atau sistem
    if (message.isStatus) return;

    const senderPhone = message.from;
    const senderName = message.sender.pushname || 'Tanpa Nama';

    // Simpan pengirim ke database
    try {
        await addSender(senderName, senderPhone);
    } catch (error) {
        console.error('Gagal menyimpan pengirim:', error);
    }

    // Normalisasi pesan
    const text = message.body.toLowerCase().trim();
    const parts = text.split(/\s+/);

    // Proses untuk pesan di grup
    if (message.from.includes('@g.us')) {
        // Cek format: nama_barang harga
        if (parts.length === 2) {
            const name = parts[0];
            try {
                const price = parsePrice(parts[1]);

                if (!isNaN(price) && price > 0) {
                    const category = determineCategory(name);

                    // Tambah pengeluaran
                    await addExpense(name, category, price);

                    // Kirim konfirmasi
                    await client.sendMessage(message.from,
                        `✅ Pengeluaran dicatat:\n` +
                        `📝 Item: ${name}\n` +
                        `📊 Kategori: ${category}\n` +
                        `💰 Harga: ${price.toLocaleString('id-ID')} IDR\n\n` +
                        `💡 Tips: Hemat pangkal kaya!`
                    );
                }
            } catch (error) {
                console.error('Gagal mencatat pengeluaran:', error);
            }
        }

        // Perintah download Excel
        // Dalam event listener
        if (text === 'download pengeluaran') {
            try {
                const fileName = await generateExcel();

                // Gunakan URL deployment Vercel Anda
                const downloadUrl = `https://your-vercel-domain.vercel.app/download/${fileName}`;

                await client.sendMessage(message.from,
                    `📊 Laporan Pengeluaran\n\n` +
                    `✅ File Excel telah dibuat!\n` +
                    `🔗 Unduh di: ${downloadUrl}\n\n` +
                    `💡 Link aktif dalam 1 jam`
                );
            } catch (error) {
                console.error('Gagal membuat Excel:', error);
                await client.sendMessage(message.from,
                    '❌ Ups! Gagal membuat laporan. Coba lagi nanti.'
                );
            }
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
    }
    // Proses pesan pribadi
    else {
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
});

// Jalankan server
const PORT = process.env.PORT || 1234;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});

// Buat direktori session jika belum ada
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir);
}


// Inisialisasi client WhatsApp
//client.initialize();

// Inisialisasi client WhatsApp
try {
    client.initialize();
    console.log('Client initialization started');
} catch (error) {
    console.error('Initialization error:', error);
}

// Tangani exit
process.on('SIGINT', () => {
    console.log('Menutup koneksi...');
    client.destroy();
    process.exit();
});