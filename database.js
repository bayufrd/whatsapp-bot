// database.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./expenses.db');

// Buat tabel jika belum ada
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        created_at TEXT NOT NULL  -- Menambahkan kolom created_at untuk menyimpan tanggal dan waktu
    )`);

    // Membuat tabel baru untuk menyimpan informasi pengirim
    db.run(`CREATE TABLE IF NOT EXISTS senders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL
    )`);
});

// Menutup koneksi pada saat aplikasi dihentikan
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('Error closing the database:', err.message);
        }
        console.log('Database closed.');
        process.exit(0);
    });
});

module.exports = db;