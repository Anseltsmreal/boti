// ... (kode inisialisasi di atas tetap sama)

// ==========================================
// 3. ENDPOINT CALLBACK + AUTO REFUND
// ==========================================
app.post('/callback', async (req, res) => {
    try {
        const { ref_id, status, sn, pesan } = req.body;
        console.log(`📩 Callback Diterima! RefID: ${ref_id}, Status: ${status}`);

        let trxs = readData('transactions');
        let users = readData('users');
        
        const trxIdx = trxs.findIndex(t => t.id === ref_id);

        if (trxIdx > -1) {
            const currentTrx = trxs[trxIdx];
            const userIdx = users.findIndex(u => u.whatsapp_number === currentTrx.user);

            // Cegah refund ganda jika status sebelumnya sudah gagal
            if (currentTrx.status === 'GAGAL' || currentTrx.status === 'REFUNDED') {
                return res.status(200).send('Already Processed');
            }

            // UPDATE STATUS TRANSAKSI
            trxs[trxIdx].status = status.toUpperCase();
            trxs[trxIdx].sn = sn || trxs[trxIdx].sn;

            let msgNotif = "";
            const userWa = currentTrx.user + '@c.us';

            // LOGIKA JIKA SUKSES
            if (status.toLowerCase() === 'success' || status === '1') {
                msgNotif = `✅ *TRANSAKSI SUKSES*\n\nID: ${ref_id}\nProduk: ${currentTrx.prod}\nNomor: ${currentTrx.target}\nSN: ${sn || '-'}`;
            } 
            // LOGIKA JIKA GAGAL (REFUND SALDO)
            else if (status.toLowerCase() === 'gagal' || status.toLowerCase() === 'failed' || status === '2') {
                if (userIdx > -1) {
                    // Kembalikan saldo ke user
                    users[userIdx].balance += currentTrx.price; // Pastikan field 'price' ada di data transaksi
                    writeData('users', users);
                    
                    trxs[trxIdx].status = 'REFUNDED';
                    msgNotif = `❌ *TRANSAKSI GAGAL & REFUND*\n\nID: ${ref_id}\nProduk: ${currentTrx.prod}\nStatus: Gagal dari Provider\n\n💰 *Saldo sebesar Rp ${currentTrx.price.toLocaleString()} telah dikembalikan ke akun Anda.*`;
                }
            }

            writeData('transactions', trxs);
            if (msgNotif) await client.sendMessage(userWa, msgNotif);
            
            return res.status(200).send('OK');
        }
        res.status(404).send('Not Found');
    } catch (err) {
        console.error("Callback Error:", err.message);
        res.status(500).send('Error');
    }
});

// ==========================================
// 4. LOGIKA BELI (Simpan Harga ke Transaksi untuk Refund)
// ==========================================
// Cari bagian command === '.beli' dan pastikan data transaksi menyimpan harga:

/* Potongan kode di dalam .beli saat sukses/pending:
*/
if (result.status === 'success' || result.status === 1 || result.status === 'pending' || result.status === 0) {
    const uIdx = users.findIndex(u => u.whatsapp_number === sender);
    users[uIdx].balance -= prod.price;
    writeData('users', users);

    // SIMPAN HARGA (price) ke history transaksi agar callback tahu berapa yang harus di-refund
    trxs.push({ 
        id: refId, 
        user: sender, 
        target: target, 
        prod: prod.name, 
        price: prod.price, // Wajib disimpan untuk refund
        status: (result.status === 'success' || result.status === 1) ? 'SUKSES' : 'PENDING', 
        sn: result.sn || '-' 
    });
    writeData('transactions', trxs);

    // ... sisa kode reply
}
