const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// ==========================================
// 1. KONFIGURASI ADMIN
// ==========================================
const ADMIN_NUMBER = '110762995499017'; 

const DB_PATH = './database_json';
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

const files = {
    users: path.join(DB_PATH, 'users.json'),
    api_configs: path.join(DB_PATH, 'api_configs.json'),
    products: path.join(DB_PATH, 'products.json'),
    transactions: path.join(DB_PATH, 'transactions.json')
};

function readData(key) {
    try {
        if (!fs.existsSync(files[key])) {
            fs.writeFileSync(files[key], JSON.stringify([]));
            return [];
        }
        const data = fs.readFileSync(files[key], 'utf8');
        return data ? JSON.parse(data) : [];
    } catch (e) { return []; }
}

function writeData(key, data) {
    fs.writeFileSync(files[key], JSON.stringify(data, null, 2));
}

// ==========================================
// 2. BOT ENGINE
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        executablePath: '/usr/bin/google-chrome-stable', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Bot PPOB Tokovoucher Aktif & Siap Transaksi!'));

client.on('message', async (msg) => {
    const sender = msg.from.split('@')[0];
    const body = msg.body ? msg.body.trim() : "";
    const args = body.split('|');
    const command = args[0].toLowerCase();

    let users = readData('users');
    let products = readData('products');
    let configs = readData('api_configs');
    let trxs = readData('transactions');
    
    const user = users.find(u => u.whatsapp_number === sender);
    const isOwner = (sender === ADMIN_NUMBER);

    if (command === '.daftar') {
        if (user) return msg.reply('❌ Anda sudah terdaftar.');
        users.push({ id: Date.now(), whatsapp_number: sender, balance: 0, role: isOwner ? 'admin' : 'member' });
        writeData('users', users);
        return msg.reply('✅ Pendaftaran Berhasil! Ketik .menu');
    }

    // Guard: Pastikan User terdaftar
    if (body.startsWith('.') && !user && command !== '.daftar') {
        return msg.reply('⚠️ Silakan ketik *.daftar* dulu.');
    }

    // --- MENU UTAMA ---
    if (command === '.menu' || command === '.p') {
        let m = `*MENU PPOB* 👋\nSaldo: Rp ${user.balance.toLocaleString()}\n\n1️⃣ PULSA\n2️⃣ DATA\n3️⃣ GAME\n\nKetik *.produk* untuk semua kode.`;
        return msg.reply(m);
    }

    if (command === '.produk') {
        if (products.length === 0) return msg.reply('Produk kosong.');
        let txt = `*LIST HARGA:*\n` + products.map(x => `• ${x.code} - ${x.name} (Rp ${x.price.toLocaleString()})`).join('\n');
        return msg.reply(txt);
    }

    // ==========================================
    // 3. LOGIKA BELI (FIXED)
    // ==========================================
    if (command === '.beli') {
        if (args.length < 3) return msg.reply('❌ Format: .beli nomor|kode\nContoh: .beli 08123|S10');
        
        const target = args[1].trim();
        const code = args[2].trim().toUpperCase();
        const serverId = args[3] ? args[3].trim() : "";

        const prod = products.find(p => p.code === code);
        if (!prod) return msg.reply('❌ Kode produk tidak ditemukan.');

        if (user.balance < prod.price) {
            return msg.reply(`❌ Saldo tidak cukup! Harga: Rp ${prod.price.toLocaleString()}`);
        }

        const api = configs.find(c => c.provider_name === 'tokovoucher');
        if (!api) return msg.reply('❌ API Tokovoucher belum di-set oleh Admin.');

        try {
            await msg.reply(`⏳ Sedang memproses *${prod.name}*...`);

            const refId = 'TRX' + Date.now();
            // Signature sesuai dokumentasi: md5(MEMBER_CODE:SECRET:REF_ID)
            const signature = crypto.createHash('md5')
                .update(`${api.api_key}:${api.api_secret}:${refId}`)
                .digest('hex');

            // Eksekusi API
            const response = await axios.post('https://api.tokovoucher.net/v1/transaksi', {
                ref_id: refId,
                produk: code,
                tujuan: target,
                server_id: serverId,
                member_code: api.api_key,
                signature: signature
            }, { timeout: 30000 }); // Timeout 30 detik agar tidak gantung

            const result = response.data;
            console.log("Respon Tokovoucher:", result);

            // Cek Status (Tokovoucher biasanya mengembalikan status 1 untuk sukses)
            if (result.status === 'success' || result.status === 1 || result.status === '1') {
                const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                users[uIdx].balance -= prod.price;
                writeData('users', users);

                trxs.push({ id: refId, user: sender, target, prod: prod.name, status: 'SUKSES', sn: result.sn || '-' });
                writeData('transactions', trxs);

                return msg.reply(`✅ *TRANSAKSI BERHASIL*\n\nID: ${refId}\nItem: ${prod.name}\nNomor: ${target}\nSN: ${result.sn || '-'}\nSisa Saldo: Rp ${users[uIdx].balance.toLocaleString()}`);
            } 
            else if (result.status === 'pending') {
                const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                users[uIdx].balance -= prod.price;
                writeData('users', users);
                return msg.reply(`⏳ *TRANSAKSI PENDING*\nSaldo terpotong, silakan cek SN nanti.\nID: ${refId}`);
            } 
            else {
                return msg.reply(`❌ *TRANSAKSI GAGAL*\nPesan: ${result.message || 'Ditolak Provider'}`);
            }
        } catch (err) {
            console.error("EROR API:", err.response ? err.response.data : err.message);
            return msg.reply('❌ Gagal terhubung ke server Tokovoucher. Cek koneksi VPS Anda.');
        }
    }

    // --- ADMIN COMMANDS ---
    if (isOwner) {
        if (command === '.addp') {
            const [_, sku, name, price, prov] = args;
            if (!sku || !name || !price) return msg.reply('Format salah.');
            const idx = products.findIndex(p => p.code === sku.toUpperCase());
            const data = { code: sku.toUpperCase(), name, price: parseInt(price), provider: prov.toLowerCase() };
            if (idx > -1) products[idx] = data; else products.push(data);
            writeData('products', products);
            return msg.reply(`✅ Produk ${sku} disimpan.`);
        }

        if (command === '.tambahsaldo') {
            const [_, targetWa, jumlah] = args;
            const uIdx = users.findIndex(u => u.whatsapp_number === targetWa);
            if (uIdx === -1) return msg.reply('User tidak ditemukan.');
            users[uIdx].balance += parseInt(jumlah);
            writeData('users', users);
            return msg.reply(`✅ Saldo ${targetWa} +Rp ${parseInt(jumlah).toLocaleString()}`);
        }

        if (command === '.setppob') {
            const [_, prov, url, key, secret] = args;
            const idx = configs.findIndex(c => c.provider_name === prov.toLowerCase());
            const data = { provider_name: prov.toLowerCase(), base_url: url, api_key: key, api_secret: secret };
            if (idx > -1) configs[idx] = data; else configs.push(data);
            writeData('api_configs', configs);
            return msg.reply(`✅ Config ${prov} Berhasil.`);
        }
    }
});

client.initialize();
app.listen(3000);
