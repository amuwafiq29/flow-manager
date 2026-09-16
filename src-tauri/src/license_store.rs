use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};

// FlowManager License - ganti LICENSE_SERVER_URL dengan server milikmu.
// Cara ganti: edit fallback di bawah, atau set env FM_LICENSE_SERVER_URL saat build.
fn api_base() -> String {
    match option_env!("FM_LICENSE_SERVER_URL") {
        Some(v) => v.to_string(),
        None => obfstr::obfstr!("https://YOUR-LICENSE-SERVER.workers.dev").to_string(),
    }
}

// Pubkey Ed25519 server (PEM, build-time via env FM_LICENSE_PUBKEY).
// Tanpa ini: mode dev, signature dilewati dengan peringatan.
fn verifying_key() -> Option<VerifyingKey> {
    let pem = option_env!("FM_LICENSE_PUBKEY")?;
    let der = pem_to_der_spki(pem)?;
    VerifyingKey::from_bytes(&der[der.len() - 32..].try_into().ok()?).ok()
}

fn pem_to_der_spki(pem: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let body: String = pem
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.contains("BEGIN") && !l.contains("END"))
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

const CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
const GRACE_OFFLINE_MS: u64 = 72 * 60 * 60 * 1000;
const REVALIDATE_MS: u64 = 15 * 60 * 1000;

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn make_nonce() -> (String, u64) {
    let ts = now_ms();
    let n = NONCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    (format!("{:x}{:x}{:x}", ts, std::process::id(), n), ts)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LicenseState {
    pub plan: String,
    pub status: String,
    pub expires_at: Option<String>,
    pub lifetime: bool,
    pub last_validated_at: String,
    pub device_id: String,
}

#[derive(Deserialize)]
struct ServerResponse {
    status: String,
    plan: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    lifetime: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    now: Option<u64>,
    #[serde(default)]
    sig: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
}

/// Keputusan lisensi terpusat (kill-switch): frontend hanya display.
#[derive(Default)]
pub struct LicenseEnforcer {
    inner: Mutex<EnforcerState>,
}

#[derive(Default)]
struct EnforcerState {
    licensed: bool,
}

impl LicenseEnforcer {
    pub fn set(&self, licensed: bool) {
        if let Ok(mut s) = self.inner.lock() {
            s.licensed = licensed;
        }
    }
}

fn path<R: Runtime>(a: &AppHandle<R>) -> Result<PathBuf, String> {
    a.path()
        .resolve("license-state.json", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}
fn read<R: Runtime>(a: &AppHandle<R>) -> Result<Option<LicenseState>, String> {
    let p = path(a)?;
    if !p.exists() {
        return Ok(None);
    };
    serde_json::from_str(&fs::read_to_string(p).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn write<R: Runtime>(a: &AppHandle<R>, s: &LicenseState) -> Result<(), String> {
    let p = path(a)?;
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?
    };
    fs::write(p, serde_json::to_vec(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn entry() -> Result<Entry, String> {
    Entry::new(
        obfstr::obfstr!("FlowManager"),
        obfstr::obfstr!("license-key"),
    )
    .map_err(|e| e.to_string())
}

/// Device ID stabil per mesin (Windows MachineGuid). Reinstall tidak me-reset.
/// Gagal baca -> tolak aktivasi (jangan generate acak).
fn hardware_device_id() -> Result<String, String> {
    let guid = windows_registry::LOCAL_MACHINE
        .open(r"SOFTWARE\Microsoft\Cryptography")
        .map_err(|e| e.to_string())?
        .get_string("MachineGuid")
        .map_err(|e| e.to_string())?;
    let guid = guid.trim();
    if guid.is_empty() {
        return Err("Unable to read device identity".to_string());
    }
    Ok(format!("hwid-{}", guid.to_lowercase()))
}

fn device<R: Runtime>(a: &AppHandle<R>) -> Result<String, String> {
    // Selalu baca hardware; cache hanya untuk kompatibilitas state lama.
    match hardware_device_id() {
        Ok(id) => Ok(id),
        Err(_) => {
            // Fallback terakhir: pakai yang tersimpan (mesin lama), atau tolak.
            if let Some(s) = read(a)? {
                if !s.device_id.is_empty() {
                    return Ok(s.device_id);
                }
            }
            Err("Unable to read device identity".to_string())
        }
    }
}

fn last_validated_ms(s: &LicenseState) -> u64 {
    chrono::DateTime::parse_from_rfc3339(&s.last_validated_at)
        .map(|d| d.timestamp_millis().max(0) as u64)
        .unwrap_or(0)
}

fn is_active(s: &LicenseState, now: u64) -> bool {
    if s.status.is_empty() {
        return false;
    }
    if s.lifetime {
        return true;
    }
    match &s.expires_at {
        Some(e) => chrono::DateTime::parse_from_rfc3339(e)
            .map(|d| (d.timestamp_millis().max(0) as u64) > now)
            .unwrap_or(false),
        None => false,
    }
}

fn verify_response(d: &ServerResponse, nonce: &str) -> Result<(), String> {
    let key = match verifying_key() {
        Some(k) => k,
        None => {
            eprintln!("[license] WARNING: FM_LICENSE_PUBKEY tidak diset — lewati verifikasi signature (mode dev)");
            return Ok(());
        }
    };
    let sig_b64 = d.sig.as_deref().ok_or("Invalid Server Response")?;
    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        sig_b64,
    )
    .map_err(|_| "Invalid Server Response")?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "Invalid Server Response")?;
    let msg = format!(
        "{}|{}|{}|{}|{}|{}",
        d.status,
        d.plan,
        d.expires_at.as_deref().unwrap_or(""),
        if d.lifetime { "1" } else { "0" },
        d.now.unwrap_or(0),
        d.nonce.as_deref().unwrap_or("")
    );
    key.verify(msg.as_bytes(), &sig)
        .map_err(|_| "Invalid Server Response")?;
    if d.nonce.as_deref().unwrap_or("") != nonce {
        return Err("Invalid Server Response".to_string());
    }
    if let Some(server_now) = d.now {
        let local = now_ms() as i64;
        if (server_now as i64 - local).abs() > CLOCK_SKEW_MS {
            return Err("Invalid Server Response".to_string());
        }
    }
    Ok(())
}

fn map_error(code: Option<&str>, http: u16) -> String {
    match code {
        Some("LICENSE_REVOKED") => "License Revoked",
        Some("OLD_KEY_REVOKED") => "Old License Revoked",
        Some("LICENSE_EXPIRED") => "License Expired",
        Some("OLD_KEY_DEAD") => "Old License Expired Permanently",
        Some("DEVICE_ALREADY_BOUND") => "Device Mismatch",
        Some("DEVICE_MISMATCH") => "Device Mismatch",
        Some("INVALID_LICENSE") => "Invalid License",
        Some("KEY_CONSUMED") => "License Key Already Used",
        Some("KEY_SUPERSEDED") => "License Key Replaced",
        Some("ALREADY_LIFETIME_COVERED") => "Device Already Lifetime",
        Some("STALE_REQUEST") => "Request Expired, Try Again",
        _ if http >= 500 => "Server Unavailable",
        _ => "Unexpected Server Response",
    }
    .to_string()
}

async fn call<R: Runtime>(
    a: &AppHandle<R>,
    endpoint: &str,
    extra: serde_json::Value,
) -> Result<ServerResponse, String> {
    let (nonce, ts) = make_nonce();
    let mut body = serde_json::json!({"licenseKey": "", "deviceId": device(a)?, "nonce": nonce, "ts": ts});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        body[k] = v;
    }
    let r = reqwest::Client::new()
        .post(format!("{}{endpoint}", api_base()))
        .json(&body)
        .send()
        .await
        .map_err(|_| "Server Unavailable".to_string())?;
    let code = r.status();
    // PENTING: body error ({error:...}) TIDAK punya field status/plan/lifetime,
    // jadi parse ServerResponse di sini akan selalu gagal. Parse terpisah.
    if !code.is_success() {
        let err_body: serde_json::Value = r.json().await.unwrap_or_default();
        let err_code = err_body.get("error").and_then(|e| e.as_str());
        return Err(map_error(err_code, code.as_u16()));
    }
    let d: ServerResponse = r
        .json()
        .await
        .map_err(|_| "Server Unavailable".to_string())?;
    verify_response(&d, &nonce)?;
    Ok(d)
}

fn state<R: Runtime>(a: &AppHandle<R>, d: ServerResponse) -> Result<LicenseState, String> {
    let s = LicenseState {
        plan: d.plan,
        status: d.status,
        expires_at: d.expires_at,
        lifetime: d.lifetime,
        last_validated_at: chrono::Utc::now().to_rfc3339(),
        device_id: device(a)?,
    };
    write(a, &s)?;
    a.state::<LicenseEnforcer>().set(is_active(&s, now_ms()));
    Ok(s)
}

#[tauri::command]
pub fn get_device_id<R: Runtime>(a: AppHandle<R>) -> Result<String, String> {
    device(&a)
}

#[tauri::command]
pub fn get_license_state<R: Runtime>(a: AppHandle<R>) -> Result<Option<LicenseState>, String> {
    read(&a)
}

#[tauri::command]
pub fn get_license_server_url() -> String {
    api_base()
}

#[tauri::command]
pub async fn activate_license<R: Runtime>(
    a: AppHandle<R>,
    license_key: String,
) -> Result<LicenseState, String> {
    let key = license_key.trim();
    if key.is_empty() {
        return Err("Invalid License".into());
    };
    let d = call(
        &a,
        "/license/activate",
        serde_json::json!({"licenseKey": key}),
    )
    .await?;
    entry()?.set_password(key).map_err(|e| e.to_string())?;
    state(&a, d)
}

#[tauri::command]
pub async fn validate_license<R: Runtime>(a: AppHandle<R>) -> Result<LicenseState, String> {
    let key = entry()?
        .get_password()
        .map_err(|_| "Invalid License".to_string())?;
    match call(&a, "/license/validate", serde_json::json!({"licenseKey": key})).await {
        Ok(d) => state(&a, d),
        Err(e) if e == "Server Unavailable" => {
            // Grace offline 72 jam: cache terakhir yang masih aktif.
            if let Some(cached) = read(&a)? {
                let now = now_ms();
                if is_active(&cached, now) && now.saturating_sub(last_validated_ms(&cached)) < GRACE_OFFLINE_MS {
                    a.state::<LicenseEnforcer>().set(true);
                    return Ok(cached);
                }
            }
            a.state::<LicenseEnforcer>().set(false);
            Err(e)
        }
        Err(e) => {
            a.state::<LicenseEnforcer>().set(false);
            Err(e)
        }
    }
}

/// Dipanggil sebelum aksi sensitif (mis. open provider). Kill-switch terpusat.
pub async fn ensure_feature_allowed<R: Runtime>(a: &AppHandle<R>) -> Result<LicenseState, String> {
    let cached = read(a)?.ok_or("Invalid License".to_string())?;
    let now = now_ms();
    if !is_active(&cached, now) {
        a.state::<LicenseEnforcer>().set(false);
        return Err(if cached.status.is_empty() {
            "Invalid License".to_string()
        } else {
            "License Expired".to_string()
        });
    }
    // Re-validasi bila cache lebih tua dari interval.
    if now.saturating_sub(last_validated_ms(&cached)) >= REVALIDATE_MS {
        return validate_license(a.clone()).await;
    }
    a.state::<LicenseEnforcer>().set(true);
    Ok(cached)
}

#[tauri::command]
pub fn clear_license_state<R: Runtime>(a: AppHandle<R>) -> Result<(), String> {
    let _ = entry()?.delete_credential();
    a.state::<LicenseEnforcer>().set(false);
    let p = path(&a)?;
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?
    };
    Ok(())
}


#[cfg(test)]
mod sig_tests {
    use super::*;

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn verify_node_signature_vector() {
        // Vektor dibuat node gen-vector.js (ed25519, pesan pipe-joined).
        let pub_der = hex_to_bytes("302a300506032b657003210096887dc5b6ae557746d673c7b57daf107a51e5da29dfb55326f34e0e7c3912f1");
        let key = VerifyingKey::from_bytes(&pub_der[pub_der.len() - 32..].try_into().unwrap()).unwrap();
        let sig_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            "8ZYbO0X9BSBhIFd5ydQgum/zOgOaMZnjTzTJHf1HKO54G07BRaxd4E1qu5HWYGYFB+Si4BtrXQIkX5CLz16gCQ==",
        )
        .unwrap();
        let sig = Signature::from_slice(&sig_bytes).unwrap();
        key.verify(b"active|thirty_days|2026-10-07T00:00:00.000Z|0|1234567890|abc123", &sig).expect("signature vector harus valid");
        // pesan yang diubah 1 byte harus GAGAL
        let mut tampered = b"active|thirty_days|2026-10-07T00:00:00.000Z|0|1234567890|abc123".to_vec();
        tampered.push(b'x');
        assert!(key.verify(&tampered, &sig).is_err());
    }
}
