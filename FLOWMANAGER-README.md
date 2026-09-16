# FlowManager — hasil rebuild dari Flowpilot 1.2.3

Rebrand penuh: Flowpilot → FlowManager, UI light theme biru gradien modern minimalis,
license server mandiri (ganti ke server milikmu).

## Yang sudah dikerjakan

1. **Rebrand**
   - `package.json` name `flowmanager`, `src-tauri/tauri.conf.json` productName `FlowManager`,
     identifier `com.flowmanager.desktop`, `Cargo.toml` name `flowmanager`
   - Semua string `Flowpilot/flowpilot/FLOWPILOT` → `FlowManager/flowmanager/FLOWMANAGER`
   - Keyring service `FlowManager`, localStorage `flowmanager-*`, updater URL github `flowmanager`

2. **License server baru (milikmu)**
   - App menunjuk ke `https://YOUR-LICENSE-SERVER.workers.dev` (1 baris di `src-tauri/src/license_store.rs`)
   - Ganti dengan URL kamu, atau build dengan env:
     `$env:FM_LICENSE_SERVER_URL="https://lisensi.kamu.com"; npm run tauri build`
   - Sistem server ada di `license-server/`:
     - `worker.js` + `wrangler.toml` (Cloudflare Worker, gratis)
     - `server.js` (Node tanpa dependency, untuk VPS)
     - `generate-key.js`, `licenses.example.json`, `README.md`
   - Sudah dites lokal: `POST /license/activate` → `{status, plan, expiresAt, lifetime}` OK
   - Ganti link beli di `src/App.tsx` → `LICENSE_PURCHASE_URL`

3. **UI baru**
   - Light theme `#f4f7ff`, kartu putih, aksen gradien biru `#2563eb → #3b82f6 → #06b6d4`
   - Sidebar putih, menu aktif gradien biru, tombol primary gradien + shadow biru
   - File diubah: `src/styles/global.css`, `account-menu.css`, `info-privacy.css`,
     `license-restore.css`, `profile-license.css`, `updater.css`
   - `tauri.conf.json` window theme `Dark` → `Light`
   - Verified: `npx tsc -b` OK, `npx vite build` OK (dist 187KB JS + 15KB CSS)

## Cara pakai

1. Deploy license server dulu (lihat `license-server/README.md`), dapat URL mis. `https://fm-licensi.xxx.workers.dev`
2. Edit `src-tauri/src/license_store.rs` → ganti `https://YOUR-LICENSE-SERVER.workers.dev`
   Edit `src/App.tsx` → `LICENSE_PURCHASE_URL`, `TELEGRAM_CHANNEL_URL`
   Edit `src-tauri/src/lib.rs` → whitelist domain toko kamu di `open_external_url`
3. Install Rust: https://rustup.rs/ (butuh `cargo`)
4. Build installer:
   ```
   cd "D:\APP PROJECT FARMING AI\FlowManager"
   npm install
   $env:FM_LICENSE_SERVER_URL="https://server-kamu..."
   npm run tauri build
   ```
   Hasil: `src-tauri/target/release/bundle/nsis/FlowManager_*_x64-setup.exe`

## Struktur
- `src/App.tsx` — UI utama
- `src-tauri/src/license_store.rs` — client lisensi (activate/validate)
- `src-tauri/src/lib.rs`, `webview_manager.rs`, `account_store.rs` — backend
- `license-server/` — sistem lisensi mandiri
- `dist/` — hasil build frontend terbaru
