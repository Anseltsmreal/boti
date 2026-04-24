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
// 1. KONFIGURASI ADMIN & DATABASE
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

// Fungsi Helper Baca/Tulis (Sudah ditambahkan pengaman file korup)
function readData(key) {
    try {
        if (!fs.existsSync(files[key])) {
            fs.writeFileSync(files[key], JSON.stringify([]));
            return [];
        }
        const data = fs.readFileSync(files[key], 'utf8');
        const parsed = data ? JSON.parse(data) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error(`Error baca ${key}:`, e.message);
        return [];
    }
}

function writeData(key, data) {
    try {
        fs.writeFileSync(files[key], JSON.stringify(data, null, 2));
    } catch (e) { console.error(`Error tulis ${key}`); }
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
client.on('ready', () => console.log('✅ Bot PPOB Tokovoucher Online & Siap!'));

// ==========================================
// 3. LOGIKA PESAN MASUK
// ==========================================
client.on('message', async (msg) => {
    try { // <-- GLOBAL CATCH AGAR BOT TIDAK DIAM SAJA JIKA ERROR
        const sender = msg.from.split('@')[0];
        const rawBody = msg.body ? msg.body.trim() : "";
        
        if (!rawBody) return;

        // ========================================================
        // FIX BUG PARSING: Mengubah spasi setelah command menjadi |
        // Contoh: ".beli 08123|S10" otomatis diubah jadi ".beli|08123|S10"
        // ========================================================
        const body = rawBody.replace(/^(\.[a-zA-Z0-9]+)\s+/, '$1|');
        const args = body.split('|');
        const command = args[0].toLowerCase();

        // Load Data
        let users = readData('users');
        let products = readData('products');
        let configs = readData('api_configs');
        let trxs = readData('transactions');
        
        const user = users.find(u => u.whatsapp_number === sender);
        const isOwner = (sender === ADMIN_NUMBER);

        // --- FITUR DAFTAR ---
        if (command === '.daftar') {
            if (user) return msg.reply('❌ Anda sudah terdaftar.');
            users.push({ id: Date.now(), whatsapp_number: sender, balance: 0, role: isOwner ? 'admin' : 'member' });
            writeData('users', users);
            return msg.reply('✅ Pendaftaran Berhasil! Ketik *.menu*');
        }

        // Guard: Belum terdaftar
        if (command.startsWith('.') && !user && command !== '.daftar') {
            return msg.reply('⚠️ Nomor belum terdaftar. Ketik *.daftar* dulu.');
        }

        // --- MENU UTAMA ---
        if (command === '.menu' || command === '.p' || command === '.produk') {
            if (command === '.menu') {
                return msg.reply(`*MENU PPOB* 👋\nSaldo: Rp ${(user.balance || 0).toLocaleString()}\n\n1️⃣ PULSA\n2️⃣ DATA\n3️⃣ GAME\n\nKetik *.produk* untuk semua harga.`);
            }
            if (command === '.produk' || command === '.p') {
                if (products.length === 0) return msg.reply('Belum ada produk.');
                return msg.reply(`*DAFTAR HARGA:*\n` + products.map(x => `• ${x.code} - ${x.name} (Rp ${x.price.toLocaleString()})`).join('\n'));
            }
        }

        if (command === '1') {
            const p = products.filter(x => x.name.toLowerCase().includes('pulsa'));
            if (p.length === 0) return msg.reply('Produk pulsa kosong.');
            return msg.reply(`*LIST PULSA:*\n` + p.map(x => `- ${x.code}: ${x.name} (Rp ${x.price.toLocaleString()})`).join('\n') + `\n\nCara beli: *.beli nomor|kode*`);
        }

        // ==========================================
        // 4. LOGIKA BELI TOKOVOUCHER (ANTI-ERROR)
        // ==========================================
        if (command === '.beli') {
            if (args.length < 3) return msg.reply('❌ Format salah!\nGunakan: .beli nomor|kode\nContoh: .beli 0812345|S10');
            
            const target = args[1].trim();
            const code = args[2].trim().toUpperCase();
            const serverId = args[3] ? args[3].trim() : "";

            const prod = products.find(p => p.code === code);
            if (!prod) return msg.reply(`❌ Kode *${code}* tidak ada. Cek ketik .produk`);

            if (user.balance < prod.price) {
                return msg.reply(`❌ Saldo kurang!\nHarga: Rp ${prod.price.toLocaleString()}\nSaldo: Rp ${user.balance.toLocaleString()}`);
            }

            const api = configs.find(c => c.provider_name === 'tokovoucher');
            if (!api) return msg.reply('❌ Sistem error: API Tokovoucher belum diset Admin.');

            msg.reply(`⏳ Memproses *${prod.name}* ke *${target}*...`);

            try {
                const refId = 'TRX' + Date.now();
                const signature = crypto.createHash('md5')
                    .update(`${api.api_key}:${api.api_secret}:${refId}`)
                    .digest('hex');

                let payload = {
                    ref_id: refId,
                    produk: code,
                    tujuan: target,
                    member_code: api.api_key,
                    signature: signature
                };
                if (serverId) payload.server_id = serverId;

                const response = await axios.post('https://api.tokovoucher.net/v1/transaksi', payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000 
                });

                const result = response.data;
                console.log("=== RES TOKOVOUCHER ===", result);

                if (result.status === 'success' || result.status === 1 || String(result.status) === '1') {
                    const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                    users[uIdx].balance -= prod.price;
                    writeData('users', users);

                    trxs.push({ id: refId, user: sender, target, prod: prod.name, status: 'SUKSES', sn: result.sn || '-' });
                    writeData('transactions', trxs);

                    return msg.reply(`✅ *BERHASIL*\n\nID: ${refId}\nItem: ${prod.name}\nNomor: ${target}\nSN: ${result.sn || '-'}\nSisa Saldo: Rp ${users[uIdx].balance.toLocaleString()}`);
                
                } else if (result.status === 'pending' || result.status === 0 || String(result.status) === '0') {
                    const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                    users[uIdx].balance -= prod.price;
                    writeData('users', users);
                    return msg.reply(`⏳ *PENDING*\nPesanan diproses server.\nID: ${refId}`);
                
                } else {
                    return msg.reply(`❌ *GAGAL*\nKet: ${result.message || result.error_msg || 'Ditolak'}\n(Saldo tidak dipotong)`);
                }

            } catch (err) {
                let errorMsg = "Sistem sibuk.";
                if (err.response && err.response.data) {
                    errorMsg = err.response.data.error_msg || err.response.data.message || JSON.stringify(err.response.data);
                }
                console.error("API ERROR:", errorMsg);
                return msg.reply(`❌ *GAGAL API*\nKet: ${errorMsg}`);
            }
        }

        // ==========================================
        // 5. FITUR ADMIN
        // ==========================================
        if (isOwner) {
            if (command === '.addp') {
                if (args.length < 5) return msg.reply('Format: .addp|KODE|NAMA|HARGA|PROVIDER');
                const sku = args[1].trim().toUpperCase();
                const name = args[2].trim();
                const price = parseInt(args[3].trim());
                const prov = args[4].trim().toLowerCase();

                const idx = products.findIndex(p => p.code === sku);
                const newData = { code: sku, name, price, provider: prov };

                if (idx > -1) products[idx] = newData; else products.push(newData);
                writeData('products', products);
                return msg.reply(`✅ Produk *${sku}* Disimpan.`);
            }

            if (command === '.setppob') {
                if (args.length < 5) return msg.reply('Format: .setppob|tokovoucher|URL|MEMBER_CODE|SECRET');
                const [_, prov, url, key, secret] = args;
                const idx = configs.findIndex(c => c.provider_name === prov.toLowerCase());
                const data = { provider_name: prov.toLowerCase(), base_url: url, api_key: key, api_secret: secret };
                if (idx > -1) configs[idx] = data; else configs.push(data);
                writeData('api_configs', configs);
                return msg.reply(`✅ Config ${prov} Diperbarui.`);
            }

            if (command === '.tambahsaldo') {
                if (args.length < 3) return msg.reply('Format: .tambahsaldo|NOMOR|JUMLAH');
                const [_, targetWa, jumlah] = args;
                const uIdx = users.findIndex(u => u.whatsapp_number === targetWa);
                if (uIdx === -1) return msg.reply('User tidak ditemukan.');
                users[uIdx].balance += parseInt(jumlah);
                writeData('users', users);
                return msg.reply(`✅ Saldo ${targetWa} +Rp ${parseInt(jumlah).toLocaleString()}`);
            }
        }
    } catch (globalError) {
        // JIKA ADA ERROR FATAL, BOT TIDAK AKAN DIAM SAJA
        console.error("GLOBAL FATAL ERROR:", globalError);
        msg.reply("⚠️ Maaf, ada sedikit gangguan teknis pada sistem bot.");
    }
});

client.initialize();
app.listen(3000, () => console.log('🚀 Server Aktif'));
