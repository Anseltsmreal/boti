const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');

// === INISIALISASI EXPRESS (WAJIB DI ATAS) ===
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

function readData(key) {
    try {
        if (!fs.existsSync(files[key])) {
            fs.writeFileSync(files[key], JSON.stringify([]));
            return [];
        }
        const data = fs.readFileSync(files[key], 'utf8');
        const parsed = data ? JSON.parse(data) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
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
client.on('ready', () => console.log('✅ Bot PPOB & Callback Server Aktif!'));

// ==========================================
// 3. ENDPOINT CALLBACK + AUTO REFUND
// ==========================================
app.post('/callback', async (req, res) => {
    try {
        const { ref_id, status, sn } = req.body;
        console.log(`📩 Callback: RefID ${ref_id} -> Status ${status}`);

        let trxs = readData('transactions');
        let users = readData('users');
        
        const trxIdx = trxs.findIndex(t => t.id === ref_id);
        if (trxIdx === -1) return res.status(404).send('Not Found');

        const currentTrx = trxs[trxIdx];
        const userIdx = users.findIndex(u => u.whatsapp_number === currentTrx.user);

        // Jika status sudah final, abaikan
        if (currentTrx.status === 'SUKSES' || currentTrx.status === 'REFUNDED') {
            return res.status(200).send('Already Processed');
        }

        const userWa = currentTrx.user + '@c.us';
        let msgNotif = "";

        // LOGIKA SUKSES
        if (status.toLowerCase() === 'success' || status == '1') {
            trxs[trxIdx].status = 'SUKSES';
            trxs[trxIdx].sn = sn || '-';
            msgNotif = `✅ *TRANSAKSI BERHASIL*\n\nID: ${ref_id}\nProduk: ${currentTrx.prod}\nNomor: ${currentTrx.target}\nSN: ${sn || '-'}`;
        } 
        // LOGIKA GAGAL & REFUND
        else if (status.toLowerCase() === 'gagal' || status.toLowerCase() === 'failed' || status == '2') {
            if (userIdx > -1) {
                users[userIdx].balance += currentTrx.price;
                writeData('users', users);
                
                trxs[trxIdx].status = 'REFUNDED';
                msgNotif = `❌ *TRANSAKSI GAGAL & REFUND*\n\nID: ${ref_id}\nProduk: ${currentTrx.prod}\n\n💰 Saldo Rp ${currentTrx.price.toLocaleString()} telah dikembalikan ke akun Anda.`;
            }
        }

        writeData('transactions', trxs);
        if (msgNotif) await client.sendMessage(userWa, msgNotif);
        
        res.status(200).send('OK');
    } catch (err) {
        res.status(500).send('Error');
    }
});

// ==========================================
// 4. LOGIKA PESAN WHATSAPP
// ==========================================
client.on('message', async (msg) => {
    try {
        const sender = msg.from.split('@')[0];
        const rawBody = msg.body ? msg.body.trim() : "";
        if (!rawBody) return;

        // Auto-fix spasi ke format pipe
        const body = rawBody.replace(/^(\.[a-zA-Z0-9]+)\s+/, '$1|');
        const args = body.split('|');
        const command = args[0].toLowerCase();

        let users = readData('users');
        let products = readData('products');
        let configs = readData('api_configs');
        let trxs = readData('transactions');
        
        const user = users.find(u => u.whatsapp_number === sender);
        const isOwner = (sender === ADMIN_NUMBER);

        if (command === '.daftar') {
            if (user) return msg.reply('❌ Sudah terdaftar.');
            users.push({ id: Date.now(), whatsapp_number: sender, balance: 0 });
            writeData('users', users);
            return msg.reply('✅ Berhasil daftar. Ketik *.menu*');
        }

        if (command.startsWith('.') && !user && !isOwner) {
            return msg.reply('⚠️ Ketik *.daftar* dulu.');
        }

        if (command === '.menu') {
            return msg.reply(`*MENU PPOB* 👋\nSaldo: Rp ${user.balance.toLocaleString()}\n\n1️⃣ PULSA\n2️⃣ DATA\n3️⃣ GAME\n\nKetik *.produk* untuk harga.`);
        }

        if (command === '.beli') {
            if (args.length < 3) return msg.reply('❌ Format: .beli nomor|kode');
            
            const target = args[1].trim();
            const code = args[2].trim().toUpperCase();
            const prod = products.find(p => p.code === code);

            if (!prod) return msg.reply('❌ Kode salah.');
            if (user.balance < prod.price) return msg.reply('❌ Saldo kurang.');

            const api = configs.find(c => c.provider_name === 'tokovoucher');
            if (!api) return msg.reply('❌ API belum diset.');

            try {
                const refId = 'TRX' + Date.now();
                const signature = crypto.createHash('md5')
                    .update(`${api.api_key}:${api.api_secret}:${refId}`)
                    .digest('hex');

                const response = await axios.post('https://api.tokovoucher.net/v1/transaksi', {
                    ref_id: refId,
                    produk: code,
                    tujuan: target,
                    member_code: api.api_key,
                    signature: signature
                });

                const result = response.data;

                if (result.status === 'success' || result.status == 1 || result.status === 'pending' || result.status == 0) {
                    const uIdx = users.findIndex(u => u.whatsapp_number === sender);
                    users[uIdx].balance -= prod.price;
                    writeData('users', users);

                    trxs.push({ 
                        id: refId, user: sender, target, prod: prod.name, 
                        price: prod.price, status: 'PENDING', sn: '-' 
                    });
                    writeData('transactions', trxs);

                    return msg.reply(`⏳ *DIPROSES*\nID: ${refId}\nBot akan mengirim info jika status berubah.`);
                } else {
                    return msg.reply(`❌ *GAGAL*: ${result.message || 'Ditolak provider'}`);
                }
            } catch (err) {
                return msg.reply('❌ Error Koneksi API.');
            }
        }

        // Fitur Admin
        if (isOwner) {
            if (command === '.addp') {
                const [_, sku, name, price, prov] = args;
                products.push({ code: sku.toUpperCase(), name, price: parseInt(price), provider: prov });
                writeData('products', products);
                return msg.reply('✅ Produk OK.');
            }
            if (command === '.tambahsaldo') {
                const [_, targetWa, jumlah] = args;
                const uIdx = users.findIndex(u => u.whatsapp_number === targetWa);
                users[uIdx].balance += parseInt(jumlah);
                writeData('users', users);
                return msg.reply('✅ Saldo OK.');
            }
            if (command === '.setppob') {
                const [_, prov, url, key, secret] = args;
                configs.push({ provider_name: prov, base_url: url, api_key: key, api_secret: secret });
                writeData('api_configs', configs);
                return msg.reply('✅ API OK.');
            }
        }
    } catch (e) { console.log(e); }
});

client.initialize();
app.listen(3000);
