/**
 * PPOB WhatsApp Bot System
 * * Fitur:
 * 1. Dashboard Admin (Express.js)
 * 2. WhatsApp Bot Integration (whatsapp-web.js)
 * 3. Database MySQL Implementation
 * 4. Multi-API Provider (Digiflazz, Okeconnect, etc.)
 * 5. User Balance & Registration System
 */

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- DATABASE CONFIGURATION & TABLES ---
/*
  SQL Schema (Run this in your MySQL):
  
  CREATE DATABASE ppob_bot;
  USE ppob_bot;

  CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    whatsapp_number VARCHAR(20) UNIQUE,
    name VARCHAR(100),
    balance DECIMAL(15, 2) DEFAULT 0.00,
    role ENUM('user', 'admin') DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE api_configs (
    provider_name VARCHAR(50) PRIMARY KEY,
    api_key TEXT,
    api_secret TEXT,
    base_url TEXT,
    is_active BOOLEAN DEFAULT false
  );

  CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(50) UNIQUE,
    name VARCHAR(100),
    price DECIMAL(15, 2),
    provider VARCHAR(50),
    category VARCHAR(50),
    status ENUM('active', 'inactive') DEFAULT 'active'
  );

  CREATE TABLE transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    product_code VARCHAR(50),
    target_number VARCHAR(50),
    amount DECIMAL(15, 2),
    status ENUM('pending', 'success', 'failed') DEFAULT 'pending',
    ref_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
*/

let db;
async function connectDB() {
    db = await mysql.createConnection({
        host: 'localhost',
        user: 'yhbohnqt_ansetsm',
        password: 'anseltsm',
        database: 'yhbohnqt_ppob_bot'
    });
    console.log('Database Connected.');
}

// --- WHATSAPP BOT LOGIC ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

client.on('qr', (qr) => {
    // Di dashboard web, kita akan menampilkan ini sebagai gambar
    qrcode.generate(qr, { small: true });
    console.log('QR Code generated. Scan to login.');
});

client.on('ready', () => {
    console.log('WhatsApp Bot is ready!');
});

client.on('message', async (msg) => {
    const sender = msg.from.split('@')[0];
    const text = msg.body.toLowerCase();

    // 1. Fitur Mendaftar
    if (text === '.daftar') {
        try {
            const [rows] = await db.execute('SELECT * FROM users WHERE whatsapp_number = ?', [sender]);
            if (rows.length > 0) {
                msg.reply('Anda sudah terdaftar dalam sistem.');
            } else {
                await db.execute('INSERT INTO users (whatsapp_number, name) VALUES (?, ?)', [sender, 'User ' + sender]);
                msg.reply('Pendaftaran berhasil! Ketik .menu untuk melihat layanan.');
            }
        } catch (e) { console.error(e); }
    }

    // 2. Cek Saldo & Menu
    if (text === '.menu' || text === '.saldo') {
        const [user] = await db.execute('SELECT balance FROM users WHERE whatsapp_number = ?', [sender]);
        if (user.length === 0) return msg.reply('Silahkan daftar terlebih dahulu dengan ketik .daftar');
        
        msg.reply(`👋 Halo!\n\nSaldo Anda: Rp ${user[0].balance.toLocaleString()}\n\nMenu Layanan:\n1. .pulsa [nomor] [kode]\n2. .pln [id_pelanggan] [kode]\n3. .deposit [jumlah]\n\nKetik .produk untuk melihat list kode.`);
    }

    // 3. Simulasi Transaksi PPOB
    if (text.startsWith('.pulsa ')) {
        const parts = text.split(' ');
        if (parts.length < 3) return msg.reply('Format salah. Contoh: .pulsa 08123xxx S5');
        
        const target = parts[1];
        const code = parts[2].toUpperCase();

        // Validasi produk & saldo
        const [prod] = await db.execute('SELECT * FROM products WHERE code = ? AND status = "active"', [code]);
        const [usr] = await db.execute('SELECT * FROM users WHERE whatsapp_number = ?', [sender]);

        if (prod.length === 0) return msg.reply('Produk tidak ditemukan.');
        if (usr[0].balance < prod[0].price) return msg.reply('Saldo tidak cukup.');

        // Proses API (Contoh ke Digiflazz)
        // const response = await axios.post('API_URL', { code, target });
        
        // Update Saldo & Catat Transaksi (Mockup Success)
        await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [prod[0].price, usr[0].id]);
        await db.execute('INSERT INTO transactions (user_id, product_code, target_number, amount, status) VALUES (?, ?, ?, ?, "success")', 
            [usr[0].id, code, target, prod[0].price]);

        msg.reply(`✅ Transaksi Berhasil!\nProduk: ${prod[0].name}\nTujuan: ${target}\nSisa Saldo: Rp ${(usr[0].balance - prod[0].price).toLocaleString()}`);
    }
});

// --- DASHBOARD API ROUTES ---

// Ambil Status Koneksi API
app.get('/api/config', async (req, res) => {
    const [rows] = await db.execute('SELECT * FROM api_configs');
    res.json(rows);
});

// Update API Config (Digiflazz/Tokovoucher/dll)
app.post('/api/config/update', async (req, res) => {
    const { provider, key, secret, url, active } = req.body;
    await db.execute('REPLACE INTO api_configs (provider_name, api_key, api_secret, base_url, is_active) VALUES (?, ?, ?, ?, ?)', 
        [provider, key, secret, url, active]);
    res.json({ message: 'Configuration updated successfully' });
});

// Kelola Produk
app.get('/api/products', async (req, res) => {
    const [rows] = await db.execute('SELECT * FROM products');
    res.json(rows);
});

// Start Server & Bot
const PORT = 3000;
app.listen(PORT, async () => {
    await connectDB();
    client.initialize();
    console.log(`Admin Dashboard running on http://localhost:${PORT}`);
});
