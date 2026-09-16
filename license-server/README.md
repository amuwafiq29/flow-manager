# FlowManager License Server — panduan deploy & operasi

## 0. Deploy via Coolify (disarankan bila VPS sudah ada Coolify)

Repo ini Coolify-ready (`Dockerfile` sudah disediakan).

1. Coolify → New Project → New Service → **GitHub repo** `amuwafiq29/flow-manager`
   - Build Pack: **Dockerfile**
   - Dockerfile Location: `license-server/Dockerfile`
2. **Storages** (wajib! tanpa ini database hilang tiap redeploy):
   - Mount 1 volume persisten, mis. `fm-licenses` → tujuan `/app/data`
   - (`LICENSES_FILE`/`PLANS_FILE` sudah mengarah ke sana)
3. **Environment Variables** (jangan taruh di repo!):
   - `ADMIN_USER`, `ADMIN_PASS_HASH` (dari `set-admin.js`), `ADMIN_SECRET`
   - `SIGNING_PRIVATE_KEY` (PEM multi-baris — Coolify mendukung value multi-line)
   - `PORT` biarkan (Coolify mengisi otomatis)
4. **Domain**: isi domain mis. `lisensi.domainkamu.com` → HTTPS otomatis (Let's Encrypt). **Wajib HTTPS** untuk produksi.
5. **Health Check Path**: `/` (server menjawab `{ok:true}`).
6. **Replicas: 1** (jangan 2+ — session admin in-memory per container).
7. Deploy → buka `https://domainkamu/admin` → login → Generate key pertama.

## 1. Deploy VPS manual tanpa Coolify (produksi)

```bash
# di VPS (butuh Node 20+)
cp licenses.example.json licenses.json   # lalu isi/hapus demo
ADMIN_USER=admin ADMIN_PASS_HASH='<dari set-admin.js>' ADMIN_SECRET='<acak 64hex>' \
SIGNING_PRIVATE_KEY="$(cat signing-priv.pem)" PORT=8787 node server.js
```

Wajib:
- **HTTPS** di depan (Caddy paling gampang: `reverse_proxy localhost:8787` — otomatis sertifikat).
- Env via systemd EnvironmentFile, JANGAN di repo.
- Backup harian `licenses.json` + `plans.json` (cron `cp` + tanggal).

Helper:
- `node gen-keys.js` → `ADMIN_SECRET` + pasangan Ed25519. Publiknya (`SIGNING_PUBLIC_KEY`) ditanam ke build app via env `FM_LICENSE_PUBKEY`.
- `node set-admin.js <password>` → `ADMIN_PASS_HASH`.
- `node generate-key.js --plan thirty_days --prefix FM` → 1 key.
- Dashboard: `http://SERVER:8787/admin` (atau path reverse proxy).

## 2. Deploy Cloudflare Worker (cadangan)

```bash
npm i -g wrangler && wrangler login
wrangler kv namespace create LICENSES   # paste id ke wrangler.toml
wrangler secret put ADMIN_USER
wrangler secret put ADMIN_PASS_HASH
wrangler secret put ADMIN_SECRET
wrangler secret put SIGNING_PRIVATE_KEY
wrangler deploy
```
Catatan: KV read-modify-write bisa race saat request bersamaan (traffic kecil = diterima). `LICENSES_JSON` var hanya untuk tes baca.

## 3. Operasional harian (dashboard `/admin`)

- **Jualan**: Generate (single/batch) → copy key → kirim ke buyer + template §5. Untuk stok tokotelegram: generate batch 50–100, paste ke produk toko.
- **Perpanjang**: cari key → Renew (dari sisa, tidak hangus). Key expired ≤30 hari masih bisa top-up sendiri oleh buyer.
- **Ganti laptop**: Reset device → buyer aktivasi ulang (device baru ke-bind).
- **Bermasalah**: Revoke (key curian/bocor) — app terkunci dengan pesan. Unrevoke bila salah.
- **Harga**: tab Plans → ubah → TERCERMIN DI APP OTOMATIS. **Jangan lupa ubah juga harga produk di dashboard tokotelegram** (tidak ada API sinkronisasi).

## 4. Darurat

- Private key signing bocor → generate baru → deploy server → rebuild app dengan pubkey baru → paksa update (updater).
- Salah revoke → Unrevoke, buyer buka app (re-validasi otomatis ≤15 menit / restart).
- Server mati total → app jalan grace 72 jam dari validasi terakhir yang aktif, lalu kunci.

## 5. Template pesan Telegram

**Aktivasi baru:**
```
Terima kasih sudah order FlowManager 🙏
🔑 Key kamu: FM-XXXX-XXXX-XXXX
Plan: 30 hari (aktif s.d. <tanggal>)

Cara aktivasi:
1. Buka app FlowManager
2. Paste key di layar Enter your license
3. Klik Activate

Key terikat 1 laptop. Ganti laptop? chat admin + kirim Device ID (Settings > Device).
```

**Top-up / perpanjang:**
```
Key top-up kamu: FM-YYYY-YYYY-YYYY (+30 hari)
Cara pakai:
1. Buka app (kalau expired, tetap buka — pilih tab Top-up)
2. Masukkan key ini di kolom Top-up
3. Sisa waktumu otomatis ditambah, key ini hangus sekali pakai.

Key lamamu tetap yang sama, tidak perlu ganti.
```

**Ganti device:**
```
Buka app > Settings > salin Device ID > kirim ke admin.
Setelah admin reset, buka app dan aktivasi ulang dengan key lamamu.
```
