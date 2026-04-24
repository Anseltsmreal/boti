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
// 1. KONFIGURASI UTAMA
// ==========================================
const ADMIN_NUMBER = '110762995499017'; // Nomor Admin Anda

const DB_PATH = './database_json';
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

const files = {
    users: path.join(DB_PATH, 'users.json'),
    api_configs: path.join(DB_PATH, 'api_configs.json'),
    products: path.join(DB_PATH, 'products.json'),
    transactions: path.join(DB_PATH, 'transactions.json')
};

// Fungsi Helper Database
function readData(key) {
    try {
        if (!fs.existsSync(files[key])) {
            fs.writeFileSync(files[key], JSON.stringify([]));
            return [];
        }
        const data = fs.readFileSync(files[key], 'utf8');
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error(`Gagal membaca ${key}:`, e.message);
        return [];
    }
}

function writeData(key, data) {
    try {
        fs.writeFileSync(files[key], JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Gagal menulis ${key}:`, e.message);
    }
}

// ==========================================
// 2. INISIALISASI BOT
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
client.on('ready', () => console.log('✅ Bot PPOB Tokovoucher Siap!'));

// ==========================================
// 3. LOGIKA PESAN MASUK
// ==========================================
client.on('message', async (msg) => {
    const sender = msg.from.split('@')[0];
    const body = msg.body ? msg.body.trim() : "";
    const args = body.split('|');
    const command = args[0].toLowerCase();

    // Load Data Terkini
    let users = readData('users');
    let products = readData('products');
    let configs = readData('api_configs');
    let trxs = readData('transactions');
    
    // Cari Profil User
    const user = users.find(u => u.whatsapp_number === sender);
    const isOwner = (sender === ADMIN_NUMBER);

    // --- FITUR DAFTAR (Wajib bagi siapa saja) ---
    if (command === '.daftar') {
        if (user) return msg.reply('❌ Anda sudah terdaftar di database.');
        users.push({ 
            id: Date.now(), 
            whatsapp_number: sender, 
            balance: 0, 
            role: isOwner ? 'admin' : 'member' 
        });
        writeData('users', users);
        return msg.reply('✅ Pendaftaran Berhasil!\nKetik *.menu* untuk melihat layanan.');
    }

    // --- PENGAMAN UTAMA (Mencegah Error TypeError: balance) ---
    // Jika perintah diawali titik dan user belum terdaftar, STOP di sini.
    if (body.startsWith('.') && !user && command !== '.daftar') {
        return msg.reply('⚠️ Nomor Anda belum terdaftar.\nKetik *.daftar* terlebih dahulu agar bisa menggunakan fitur bot.');
    }

    // ==========================================
    // 4. PERINTAH USER (MEMBER & ADMIN)
    // ==========================================
    
    if (command === '.menu' || command === '.p' || command === '.produk') {
        if (command === '.menu') {
            let m = `*MENU UTAMA PPOB* 👋\n`;
            m += `💰 Saldo: Rp ${(user.balance).toLocaleString()}\n\n`;
            m += `Ketik angka untuk pilih kategori:\n`;
            m += `1️⃣ *PULSA*\n2️⃣ *DATA*\n3️⃣ *GAME*\n4️⃣ *INFO AKUN*\n\n`;
            m += `Atau ketik *.produk* untuk semua list harga.`;
            return msg.reply(m);
        }
        
        if (command === '.produk' || command === '.p') {
            if (products.length === 0) return msg.reply('📭 Produk belum tersedia.');
            let txt = `*DAFTAR HARGA PRODUK*\n\n` + products.map(x => `• ${x.code} - ${x.name} (Rp ${x.price.toLocaleString()})`).join('\n');
            return msg.reply(txt);
        }
    }

    // Sub-Menu Pilihan Angka
    if (command === '1') {
        const p = products.filter(x => x.name.toLowerCase().includes('pulsa'));
        if (p.length === 0) return msg.reply('Produk pulsa belum tersedia.');
        let txt = `*LIST PULSA:*\n` + p.map(x => `- ${x.code}: ${x.name} (Rp ${x.price.toLocaleString()})`).join('\n');
        return msg.reply(txt + `\n\nCara beli: *.beli nomor|kode*`);
    }

    if (command === '4') {
        return msg.reply(`*INFO AKUN ANDA*\n\nNomor: ${sender}\nSaldo: Rp ${user.balance.toLocaleString()}\nStatus: ${user.role || 'Member'}`);
    }

    // --- LOGIKA TRANSAKSI TOKOVOUCHER ---
    if (command === '.beli') {
        if (args.length < 3) return msg.reply('❌ Format: .beli nomor|kode\nContoh: .beli 0812345|S10');
        
        const target = args[1].trim();
        const code = args[2].trim().toUpperCase();
        const serverId = args[3] ? args[3].trim() : "";

        const prod = products.find(p => p.code === code);
        if (!prod) return msg.reply('❌ Kode produk tidak valid.');

        if (user.balance < prod.price) {
            return msg.reply(`❌ *SALDO KURANG!*\nHarga: Rp ${prod.price.toLocaleString()}\nSaldo: Rp ${user.balance.toLocaleString()}`);
        }

        const api = configs.find(c => c.provider_name === 'tokovoucher');
        if (!api) return msg.reply('❌ API Tokovoucher belum di-setup oleh Admin.');

        msg.reply(`⏳ Sedang memproses transaksi *${prod.name}*...`);

        try {
            const refId = 'TRX' + Date.now();
            const signature = crypto.createHash('md5')
                .update(`${api.api_key}:${api.api_secret}:${refId}`)
                .digest('hex');

            const response = await axios.post('https://api.tokovoucher.net/v1/transaksi', {
                ref_id: refId,
                produk: code,
                tujuan: target,
                server_id: serverId,
                member_code: api.api_key,
                signature: signature
            });

            const result = response.data;

            if (result.status === 'success' || result.status === 1) {
                const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                users[uIdx].balance -= prod.price;
                writeData('users', users);

                trxs.push({ id: refId, user: sender, target, prod: prod.name, status: 'SUKSES', sn: result.sn || '-' });
                writeData('transactions', trxs);

                return msg.reply(`✅ *TRANSAKSI BERHASIL*\n\nID: ${refId}\nItem: ${prod.name}\nTujuan: ${target}\nSN: ${result.sn || '-'}\nSisa Saldo: Rp ${users[uIdx].balance.toLocaleString()}`);
            } else if (result.status === 'pending') {
                const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                users[uIdx].balance -= prod.price;
                writeData('users', users);
                return msg.reply(`⏳ *TRANSAKSI PENDING*\nSaldo terpotong, pesanan diproses.\nID: ${refId}`);
            } else {
                return msg.reply(`❌ *TRANSAKSI GAGAL*\nAlasan: ${result.message || 'Ditolak API'}`);
            }
        } catch (err) {
            return msg.reply('❌ Error: Gagal menghubungi server provider.');
        }
    }

    // ==========================================
    // 5. FITUR ADMIN (KHUSUS NOMOR ADMIN)
    // ==========================================
    if (isOwner) {
        if (command === '.addp') {
            if (args.length < 5) return msg.reply('Format: .addp|KODE|NAMA|HARGA|PROVIDER');
            const [_, sku, name, price, prov] = args;
            const idx = products.findIndex(p => p.code === sku.toUpperCase());
            const data = { code: sku.toUpperCase(), name, price: parseInt(price), provider: prov.toLowerCase() };
            if (idx > -1) products[idx] = data; else products.push(data);
            writeData('products', products);
            return msg.reply(`✅ Produk ${sku} disimpan.`);
        }

        if (command === '.setppob') {
            if (args.length < 5) return msg.reply('Format: .setppob|tokovoucher|URL|MEMBER_CODE|SECRET');
            const [_, prov, url, key, secret] = args;
            const idx = configs.findIndex(c => c.provider_name === prov.toLowerCase());
            const data = { provider_name: prov.toLowerCase(), base_url: url, api_key: key, api_secret: secret };
            if (idx > -1) configs[idx] = data; else configs.push(data);
            writeData('api_configs', configs);
            return msg.reply(`✅ API Config ${prov} diperbarui.`);
        }

        if (command === '.tambahsaldo') {
            const [_, targetWa, jumlah] = args;
            const uIdx = users.findIndex(u => u.whatsapp_number === targetWa);
            if (uIdx === -1) return msg.reply('❌ User belum terdaftar (.daftar).');
            users[uIdx].balance += parseInt(jumlah);
            writeData('users', users);
            return msg.reply(`✅ Saldo ${targetWa} bertambah Rp ${parseInt(jumlah).toLocaleString()}.`);
        }
    }
});

client.initialize();
app.listen(3000, () => console.log('🚀 Server PPOB Port 3000 Aktif'));
