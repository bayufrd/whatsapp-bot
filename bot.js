// bot.js
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); // Mengimpor qrcode-terminal
const ExcelJS = require('exceljs');
const db = require('./database');
const fs = require('fs');
const path = require('path');

// Inisialisasi client WhatsApp
const client = new Client();

// Simulasi: Nama pengirim dan nomor telepon
const senderName = 'Nama Pengirim'; // Anda bisa mengupdate ini sesuai keperluan
const senderPhone = '+62123456789'; // Masukkan nomor telepon pengirim (bisa juga ambil dari message.from)

// Event ketika QR Code dihasilkan
client.on('qr', (qr) => {
    // Tampilkan QR Code ke terminal menggunakan qrcode-terminal
    qrcode.generate(qr, { small: true });  // Menampilkan QR Code dengan ukuran kecil
});

// Event ketika bot sudah siap
client.on('ready', () => {
    console.log('Bot is ready!');
});

// Fungsi untuk menambahkan pengeluaran
function addExpense(name, category, price) {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT INTO expenses (name, category, price, created_at) VALUES (?, ?, ?, ?)';
        const createdAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }); // Menggunakan waktu Indonesia
        db.run(sql, [name, category, price, createdAt], function(err) {
            if (err) {
                return reject(err);
            }
            resolve(this.lastID); // Mengembalikan ID terakhir yang dimasukkan
        });
    });
}

// Fungsi untuk menambahkan pengirim
function addSender(name, phone) {
    return new Promise((resolve, reject) => {
        const sql = 'INSERT INTO senders (name, phone) VALUES (?, ?)';
        db.run(sql, [name, phone], function(err) {
            if (err) {
                return reject(err);
            }
            resolve(this.lastID); // Mengembalikan ID terakhir yang dimasukkan
        });
    });
}

// Helper function to parse price
function parsePrice(priceString) {
    priceString = priceString.replace(/\s/g, ''); // Menghapus spasi
    let price = parseFloat(priceString.replace(/[^\d]/g, '')); // Menghapus karakter non-digit
    if (priceString.includes('rb')) {
        price *= 1000;  // Kalikan dengan 1000 jika ada 'rb'
    } else if (priceString.includes('k')) {
        price *= 1000;  // Kalikan dengan 1000 jika ada 'k'
    }
    // Pastikan output harga adalah angka bulat
    return Math.round(price);
}

// Fungsi untuk menggenerate Excel
async function generateExcel() {
    const filePath = path.join('/var/www/html/whatsapp-bot/download', 'Pengeluaran.xlsx');  // Menyimpan di folder yang ditentukan
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pengeluaran');

    // Judul bulan dan detail pengirim
    const monthYear = new Intl.DateTimeFormat('id-ID', { year: 'numeric', month: 'long' }).format(new Date());
    worksheet.mergeCells('A1:D1');
    worksheet.getCell('A1').value = `Daftar Pengeluaran Bulan ${monthYear}`;
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    worksheet.getCell('A1').alignment = { horizontal: 'center' };

    worksheet.getCell('A2').value = `Nama Pengirim: ${senderName}`;
    worksheet.getCell('A3').value = `Nomor Telepon: ${senderPhone}`;
    worksheet.getCell('A2').font = { italic: true };
    worksheet.getCell('A3').font = { italic: true };

    worksheet.addRow(); // Baris kosong

    // Menambahkan header dengan format yang lebih baik
    worksheet.columns = [
        { header: 'Tanggal dan Waktu', key: 'created_at', width: 25 },
        { header: 'Nama', key: 'name', width: 30 },
        { header: 'Kategori', key: 'category', width: 30 },
        { header: 'Harga', key: 'price', width: 15 }
    ];

    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM expenses', [], (err, rows) => {
            if (err) {
                return reject(err);
            }
            
            let total = 0; // Inisialisasi variabel total

            rows.forEach(exp => {
                // Menambahkan total harga
                total += exp.price;

                // Menambahkan setiap baris ke worksheet
                worksheet.addRow({
                    created_at: exp.created_at, // Tambahkan tanggal dan waktu
                    name: exp.name,
                    category: exp.category,
                    price: exp.price
                });
            });

            // Menambahkan baris total di bagian bawah
            worksheet.addRow({ name: 'Total', price: total });
            
            // Menambahkan styling untuk header dan total
            worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } }; // Header bold dan putih
            worksheet.getRow(1).fill = { // Warna latar belakang header
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: '4F81BD' }
            };
            worksheet.getColumn('A').alignment = { horizontal: 'center' }; // Rata tengah kolom
            worksheet.getColumn('B').alignment = { horizontal: 'left' };
            worksheet.getColumn('C').alignment = { horizontal: 'left' };
            worksheet.getColumn('D').alignment = { horizontal: 'right' };

            // Styling untuk baris total
            const totalRow = worksheet.lastRow;
            totalRow.font = { bold: true };
            totalRow.getCell(4).numberFormat = '0'; // Format angka

            workbook.xlsx.writeFile(filePath)
                .then(() => resolve(filePath))
                .catch(reject);
        });
    });
}

// Mendengarkan pesan dari WhatsApp
client.on('message', async message => {
    const senderPhone = message.from; // Mengambil nomor telepon dari pengirim
    const senderName = message.sender.pushname || 'Tanpa Nama'; // Mengambil nama pengirim

    // Simpan pengirim ke tabel
    await addSender(senderName, senderPhone);
    
    // Cek apakah pesan datang dari grup
    if (message.from.includes('@g')) { // ID grup akan mengandung '@g'
        const text = message.body.toLowerCase();
        
        // Cek format pesan
        const parts = text.split(" ");
        if (parts.length === 2) {
            const name = parts[0];
            const price = parsePrice(parts[1]); // Parsing harga dengan fungsi baru

            // Kategorikan barang
            let category;
            if (name.includes("makan") || name.includes("minum")) {
                category = "Makanan";
            } else if (name.includes("gojek") || name.includes("maxim") || name.includes("grab")) {
                category = "Transport";
            } else if (name.includes("libur")) {
                category = "Liburan";
            } else if (name.includes("token")) {
                category = "Token Listrik";
            } else if (name.includes("rokok")) {
                category = "Sahabat Sebat";
            } else if (name.includes("internet")) {
                category = "Entertaiment";
            } else {
                category = "Lain-lain"; // Kategori default
            }
            
            if (!isNaN(price) && price > 0) {
                await addExpense(name, category, price);
                client.sendMessage(message.from, `Pengeluaran telah dicatat: ${name}, Kategori: ${category}, Harga: ${price} IDR. HEMAT KONTOLL!!!`);
                return; // Keluar agar tidak melanjutkan proses ke bagian download
            }
        }

        // Periksa jika ada permintaan untuk mengunduh file Excel
        if (text === "download pengeluaran") {
            try {
                const filePath = await generateExcel();
                const url = `http://dastrevas.com/download/${path.basename(filePath)}`; // Ganti dengan URL yang sesuai
                client.sendMessage(message.from, `File Excel telah dibuat! Anda dapat mendownloadnya di: ${url}`);
            } catch (error) {
                console.error(error);
                client.sendMessage(message.from, "Terjadi kesalahan saat membuat file Excel.");
            }
        }

    } else {
        // Logika untuk pesan pribadi atau lainnya
        const text = message.body.toLowerCase();
        const parts = text.split(" ");
        
        if (parts.length === 2) {
            const name = parts[0];
            const price = parsePrice(parts[1]); // Parsing harga dengan fungsi baru
            
            if (!isNaN(price) && price > 0) {
                await addExpense(name, "Lain-lain", price); // Kategori default jika bukan grup
                await message.reply(`Pengeluaran telah dicatat: ${name}, Harga: ${price} IDR`);
            } else {
                await message.reply("Format salah. Kirim 'nama_barang harga'.");
            }
        }
    }
});

// Menjalankan client
client.initialize();