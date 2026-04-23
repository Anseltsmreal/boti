const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- CONFIG KEAMANAN ADMIN ---
const ADMIN_USER = 'admin';       
const ADMIN_PASS = 'Ansel789!'; // Ganti password ini!

// --- JSON DATABASE SYSTEM ---
const DB_PATH = './database_json';
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

const files = {
    users: path.join(DB_PATH, 'users.json'),
    api_configs: path.join(DB_PATH, 'api_configs.json'),
    products: path.join(DB_PATH, 'products.json'),
    transactions: path.join(DB_PATH, 'transactions.json'),
    deposits: path.join(DB_PATH, 'deposits.json')
};

Object.values(files).forEach(file => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify([]));
});

function readData(key) {
    try { return JSON.parse(fs.readFileSync(files[key])); } catch (e) { return []; }
}

function writeData(key, data) {
    fs.writeFileSync(files[key], JSON.stringify(data, null, 2));
}

// Middleware Autentikasi
const auth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Auth Required' });
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    if (credentials[0] === ADMIN_USER && credentials[1] === ADMIN_PASS) next();
    else res.status(401).json({ message: 'Invalid Credentials' });
};

// --- WHATSAPP BOT LOGIC ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        executablePath: '/usr/bin/google-chrome-stable', 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    }
});

client.on('qr', (qr) => { qrcode.generate(qr, { small: true }); });
client.on('ready', () => { console.log('WhatsApp Bot Ready!'); });

client.on('message', async (msg) => {
    const sender = msg.from.split('@')[0];
    const text = msg.body.toLowerCase();
    let users = readData('users');
    let products = readData('products');
    const user = users.find(u => u.whatsapp_number === sender);

    if (text === '.daftar') {
        if (user) return msg.reply('Sudah terdaftar.');
        users.push({ id: Date.now(), whatsapp_number: sender, balance: 0, role: 'user' });
        writeData('users', users);
        msg.reply('Berhasil daftar! Ketik .menu');
    }

    if (text === '.menu' || text === '.saldo') {
        if (!user) return msg.reply('Daftar dulu via .daftar');
        msg.reply(`Saldo: Rp ${user.balance.toLocaleString()}\n\nMenu:\n.pulsa [nomor] [kode]\n.deposit [jumlah]\n.produk`);
    }

    if (text.startsWith('.deposit ')) {
        const amount = parseInt(text.split(' ')[1]);
        if (amount < 10000) return msg.reply('Minimal Rp 10.000');
        const configs = readData('api_configs');
        const pay = configs.find(c => c.provider_name === 'sakurupiah');
        if (!pay) return msg.reply('Gateway belum siap.');

        const refId = 'REF' + Date.now();
        let deposits = readData('deposits');
        deposits.push({ reference: refId, user_id: user.id, amount, status: 'pending', created_at: new Date() });
        writeData('deposits', deposits);

        msg.reply(`Bayar di sini: ${pay.base_url}/pay?m=${pay.api_key}&ref=${refId}&amt=${amount}`);
    }

    if (text === '.produk') {
        let list = products.map(p => `${p.code}: ${p.name} (Rp ${p.price})`).join('\n');
        msg.reply(list || 'Produk kosong.');
    }
});

// --- API ROUTES ---
app.get('/api/products', auth, (req, res) => res.json(readData('products')));
app.get('/api/deposits', auth, (req, res) => res.json(readData('deposits')));

app.post('/api/products', auth, (req, res) => {
    let prods = readData('products');
    const index = prods.findIndex(p => p.code === req.body.code.toUpperCase());
    if (index > -1) prods[index] = req.body; else prods.push(req.body);
    writeData('products', prods);
    res.json({ message: 'Success' });
});

app.delete('/api/products/:code', auth, (req, res) => {
    let prods = readData('products').filter(p => p.code !== req.params.code.toUpperCase());
    writeData('products', prods);
    res.json({ message: 'Deleted' });
});

app.post('/api/config/update', auth, (req, res) => {
    let configs = readData('api_configs');
    const index = configs.findIndex(c => c.provider_name === req.body.provider);
    if (index > -1) configs[index] = req.body; else configs.push(req.body);
    writeData('api_configs', configs);
    res.json({ message: 'Config Updated' });
});

// Webhook SakuRupiah
app.post('/webhook/sakurupiah', (req, res) => {
    const { reference, status, amount } = req.body;
    if (status === 'success') {
        let deps = readData('deposits');
        let users = readData('users');
        const dIdx = deps.findIndex(d => d.reference === reference && d.status === 'pending');
        if (dIdx > -1) {
            const uIdx = users.findIndex(u => u.id === deps[dIdx].user_id);
            deps[dIdx].status = 'success';
            users[uIdx].balance += parseInt(amount);
            writeData('deposits', deps);
            writeData('users', users);
            client.sendMessage(`${users[uIdx].whatsapp_number}@c.us`, `Deposit Berhasil! Saldo +Rp ${amount}`);
        }
    }
    res.send('OK');
});

app.listen(3000, () => { console.log('Server running on port 3000'); client.initialize(); });
