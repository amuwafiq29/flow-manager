use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::path::BaseDirectory;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl};

// FlowManager providers:
//   google   -> Google Flow  (https://flow.google.com)
//   dola     -> Dola         (https://www.dola.com/chat/)
//   migoo    -> Migoo        (https://migoo.ai/)
//   chatgpt  -> ChatGPT      (https://chatgpt.com/)
//   minimax  -> Hailuo AI    (https://hailuoai.video/)
//   leonardo -> Leonardo AI  (https://app.leonardo.ai/)
//   custom   -> URL bebas dari user (https, divalidasi)
const PROVIDER_GOOGLE: &str = "google";
const PROVIDER_DOLA: &str = "dola";
const PROVIDER_MIGOO: &str = "migoo";
const PROVIDER_CHATGPT: &str = "chatgpt";
const PROVIDER_MINIMAX: &str = "minimax";
const PROVIDER_LEONARDO: &str = "leonardo";
const PROVIDER_CUSTOM: &str = "custom";

const GOOGLE_FLOW_URL: &str = "https://flow.google.com/";
const DOLA_URL: &str = "https://www.dola.com/chat/";
const MIGOO_URL: &str = "https://migoo.ai/";
const CHATGPT_URL: &str = "https://chatgpt.com/";
const MINIMAX_URL: &str = "https://hailuoai.video/";
const LEONARDO_URL: &str = "https://app.leonardo.ai/";

const MAX_CACHED_WEBVIEWS: usize = 10;

pub struct WebviewManager {
    active_label: Mutex<Option<String>>,
    visible: Mutex<bool>,
    cached_labels: Mutex<HashMap<String, u64>>,
    usage_counter: Mutex<u64>,
    operation: Mutex<()>,
    /// Profil (data_directory) yang extension-nya sudah diregistrasi.
    /// AddBrowserExtension yang dipanggil ulang untuk ID yang sama me-RELOAD
    /// extension -> context lama invalid ("extension context invalidated",
    /// "tabs.query timeout"). Jadi registrasi sekali per profil saja.
    ext_registered: Mutex<std::collections::HashSet<String>>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            active_label: Mutex::new(None),
            visible: Mutex::new(false),
            cached_labels: Mutex::new(HashMap::new()),
            usage_counter: Mutex::new(0),
            operation: Mutex::new(()),
            ext_registered: Mutex::new(std::collections::HashSet::new()),
        }
    }
}

/// Normalisasi input provider dari frontend.
/// Menerima "google" | "google-flow" | "dola" | "migoo" | "chatgpt" |
/// "minimax" | "leonardo" | "custom" (case-insensitive).
/// Default: "google" agar akun lama tanpa provider tetap jalan.
fn normalize_provider(raw: Option<String>) -> String {
    let lower = raw.unwrap_or_default().to_lowercase();
    let trimmed = lower.trim();
    if trimmed == PROVIDER_DOLA || trimmed == "dola.com" {
        PROVIDER_DOLA.to_string()
    } else if trimmed == PROVIDER_MIGOO || trimmed == "migoo.ai" {
        PROVIDER_MIGOO.to_string()
    } else if trimmed == PROVIDER_CHATGPT || trimmed == "chatgpt.com" || trimmed == "chat.openai.com" {
        PROVIDER_CHATGPT.to_string()
    } else if trimmed == PROVIDER_MINIMAX || trimmed == "hailuoai.video" || trimmed == "hailuo.ai" {
        PROVIDER_MINIMAX.to_string()
    } else if trimmed == PROVIDER_LEONARDO || trimmed == "leonardo.ai" || trimmed == "app.leonardo.ai" {
        PROVIDER_LEONARDO.to_string()
    } else if trimmed == PROVIDER_CUSTOM {
        PROVIDER_CUSTOM.to_string()
    } else {
        // "google", "google-flow", kosong, atau tidak dikenal -> Google Flow
        PROVIDER_GOOGLE.to_string()
    }
}

fn label_prefix(provider: &str) -> &str {
    match provider {
        PROVIDER_DOLA => "dola",
        PROVIDER_MIGOO => "migoo",
        PROVIDER_CHATGPT => "chatgpt",
        PROVIDER_MINIMAX => "minimax",
        PROVIDER_LEONARDO => "leonardo",
        PROVIDER_CUSTOM => "custom",
        _ => "google-flow",
    }
}

fn provider_url(provider: &str) -> &str {
    match provider {
        PROVIDER_DOLA => DOLA_URL,
        PROVIDER_MIGOO => MIGOO_URL,
        PROVIDER_CHATGPT => CHATGPT_URL,
        PROVIDER_MINIMAX => MINIMAX_URL,
        PROVIDER_LEONARDO => LEONARDO_URL,
        _ => GOOGLE_FLOW_URL,
    }
}

/// Validasi URL custom milik user: wajib https + host valid.
fn validate_custom_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("custom URL is required".to_string());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed: tauri::Url = with_scheme
        .parse()
        .map_err(|_| "invalid custom URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("custom URL must use https".to_string());
    }
    match parsed.host_str() {
        Some(host) if !host.is_empty() && host.contains('.') => Ok(parsed.to_string()),
        _ => Err("invalid custom URL".to_string()),
    }
}

fn webview_label(provider: &str, account_id: &str) -> String {
    format!("{}-{account_id}", label_prefix(provider))
}

fn touch_label(state: &WebviewManager, label: &str) -> Result<(), String> {
    let mut counter = state
        .usage_counter
        .lock()
        .map_err(|_| "webview state unavailable")?;
    *counter = counter.wrapping_add(1);
    let mut cached = state
        .cached_labels
        .lock()
        .map_err(|_| "webview state unavailable")?;
    cached.insert(label.to_string(), *counter);
    Ok(())
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    if account_id.is_empty()
        || account_id.len() > 128
        || !account_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid account id".to_string());
    }
    Ok(())
}

/// Klaim registrasi extension untuk satu profil. true = pertama kali
/// (builder boleh pasang extensions_path), false = sudah terdaftar
/// (lewati agar extension tidak ke-reload dan context tidak invalid).
fn claim_ext_registration(state: &WebviewManager, profile: &PathBuf) -> Result<bool, String> {
    let key = profile.to_string_lossy().to_string();
    let mut set = state
        .ext_registered
        .lock()
        .map_err(|_| "webview state unavailable")?;
    if set.contains(&key) {
        return Ok(false);
    }
    set.insert(key);
    Ok(true)
}

/// Lepas klaim saat profil dihapus agar akun yang dibuat ulang registrasi lagi.
fn release_ext_registration(state: &WebviewManager, profile: &PathBuf) -> Result<(), String> {
    let key = profile.to_string_lossy().to_string();
    state
        .ext_registered
        .lock()
        .map_err(|_| "webview state unavailable")?
        .remove(&key);
    Ok(())
}
fn profile_path<R: Runtime>(
    app: &AppHandle<R>,
    provider: &str,
    account_id: &str,
) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resolve("webview-profiles", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())?;
    // Profil terpisah per provider agar sesi login Google/Dola/Migoo tidak tercampur.
    let profile = root.join(label_prefix(provider)).join(account_id);
    let canonical_root = root.to_string_lossy().to_string();
    let canonical_profile = profile.to_string_lossy().to_string();
    if !canonical_profile.starts_with(&canonical_root) {
        return Err("invalid account profile path".to_string());
    }
    Ok(profile)
}

fn validate_bounds(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if ![x, y, width, height].iter().all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
    {
        return Err("invalid WebView bounds".to_string());
    }
    Ok(())
}

/// Folder ekstensi: %AppData%/.../extensions.
/// Tiap subfolder = 1 unpacked Chrome extension (ada manifest.json di dalamnya),
/// otomatis di-load WebView2 via AddBrowserExtension.
fn extensions_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("extensions", BaseDirectory::AppLocalData)
        .map_err(|e| e.to_string())
}

fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Nama folder extension lama yang wajib dibersihkan bila masih tersisa.
/// (Mencegah extension ID yang sama ke-load ganda dari copy basi.)
const LEGACY_EXTENSION_DIRS: &[&str] = &["zapi-flow"];

/// Hapus copy extension basi agar tidak ke-load ganda bersama versi baru.
fn sweep_stale_extensions(dir: &PathBuf, wanted: &[String]) {
    let current = match std::fs::read_dir(dir) {
        Ok(c) => c,
        Err(_) => return,
    };
    for entry in current.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().is_dir() {
            continue;
        }
        if wanted.contains(&name) {
            continue;
        }
        // Hapus bila: folder legacy yang dikenal, ATAU tidak ada di bundle
        // (hanya saat kita tahu isi bundle — wanted tidak kosong).
        let known_legacy = LEGACY_EXTENSION_DIRS.contains(&name.as_str());
        if known_legacy || !wanted.is_empty() {
            match std::fs::remove_dir_all(entry.path()) {
                Ok(()) => eprintln!("[fm-ext] removed stale extension: {name}"),
                Err(e) => eprintln!("[fm-ext] cannot remove stale {name}: {e}"),
            }
        }
    }
}
/// Siapkan ekstensi bawaan sekali saja.
/// Sumber: folder `extensions/` yang di-bundle bersama app (tauri.conf resources).
fn ensure_extensions<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = extensions_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Selalu bersihkan folder legacy dulu (tidak tergantung sumber bundle).
    for legacy in LEGACY_EXTENSION_DIRS {
        let stale = dir.join(legacy);
        if stale.is_dir() {
            match std::fs::remove_dir_all(&stale) {
                Ok(()) => eprintln!("[fm-ext] removed legacy extension: {legacy}"),
                Err(e) => eprintln!("[fm-ext] cannot remove legacy {legacy}: {e}"),
            }
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("extensions", BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join("extensions"));
        }
    }
    for src in candidates {
        if !src.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(&src) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Nama extension yang di-bundle (sumber kebenaran).
        let mut wanted: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let from = entry.path();
            if !from.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            wanted.push(name.clone());
            let to = dir.join(entry.file_name());
            if to.exists() {
                continue; // jangan timpa milik user
            }
            match copy_dir_recursive(&from, &to) {
                Ok(()) => eprintln!("[fm-ext] bundled extension installed: {}", to.display()),
                Err(e) => eprintln!("[fm-ext] extension copy failed {}: {e}", from.display()),
            }
        }
        // Hapus copy basi (mis. folder extension lama) agar tidak ke-load ganda.
        sweep_stale_extensions(&dir, &wanted);
        break;
    }
    Ok(dir)
}

pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    provider: Option<String>,
    custom_url: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let state = app.state::<WebviewManager>();
    let operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    validate_account_id(&account_id)?;
    validate_bounds(x, y, width, height)?;
    let provider = normalize_provider(provider);
    #[cfg(debug_assertions)]
    eprintln!("[fm-debug] open account={account_id} provider={provider} bounds=({x},{y},{width},{height})");
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let requested_label = webview_label(&provider, &account_id);
    #[cfg(debug_assertions)]
    eprintln!("[fm-debug] open label={requested_label} provider={provider}");
    let active_label = state
        .active_label
        .lock()
        .map_err(|_| "webview state unavailable")?
        .clone();
    if let Some(active) = active_label.as_deref() {
        if active != requested_label {
            if let Some(webview) = app.get_webview(active) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
    }

    if let Some(webview) = app.get_webview(&requested_label) {
        #[cfg(debug_assertions)]
        eprintln!("[fm-debug] open reusing existing webview {requested_label}");
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        // Fokus ke webview provider agar wheel/keyboard masuk ke situs,
        // bukan ke UI FlowManager (wheel di Windows lari ke jendela fokus).
        let _ = webview.set_focus();
        *state
            .active_label
            .lock()
            .map_err(|_| "webview state unavailable")? = Some(requested_label.clone());
        *state
            .visible
            .lock()
            .map_err(|_| "webview state unavailable")? = true;
        touch_label(&state, &requested_label)?;
        return Ok(());
    }

    {
        let mut cached = state
            .cached_labels
            .lock()
            .map_err(|_| "webview state unavailable")?;
        if cached.len() >= MAX_CACHED_WEBVIEWS {
            let eviction = cached
                .iter()
                .filter(|(label, _)| Some(label.as_str()) != active_label.as_deref())
                .min_by_key(|(_, last_used)| **last_used)
                .map(|(label, _)| label.clone());
            if let Some(evicted) = eviction {
                if let Some(webview) = app.get_webview(&evicted) {
                    webview.close().map_err(|e| e.to_string())?;
                }
                cached.remove(&evicted);
            }
        }
    }

    let profile = profile_path(app, &provider, &account_id)?;
    // Provider custom memakai URL milik user (divalidasi https).
    let url_str = if provider == PROVIDER_CUSTOM {
        validate_custom_url(&custom_url.unwrap_or_default())?
    } else {
        provider_url(&provider).to_string()
    };
    let url = WebviewUrl::External(url_str.parse().map_err(|_| "invalid provider URL")?);
    #[cfg(debug_assertions)]
    eprintln!("[fm-debug] open url={url_str}");
    let mut builder = WebviewBuilder::new(requested_label.clone(), url)
        .data_directory(profile.clone())
        // Capability flag WAJIB di tiap webview agar extension profile bisa dipakai.
        .browser_extensions_enabled(true)
        .on_navigation(|url| url.scheme() == "https")
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    // Install (AddBrowserExtension) sekali per profil saja; pengulangan
    // me-reload extension dan meng-invalidasi context yang sedang dipakai.
    if claim_ext_registration(&state, &profile)? {
        #[cfg(debug_assertions)]
        eprintln!("[fm-ext] registering extensions for {}", profile.display());
        builder = builder.extensions_path(ensure_extensions(app)?);
    } else {
        #[cfg(debug_assertions)]
        eprintln!("[fm-ext] extensions already registered, skip reload");
    }

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[fm-debug] open add_child FAILED label={requested_label}: {e}");
            e.to_string()
        })?;
    #[cfg(debug_assertions)]
    eprintln!("[fm-debug] open OK label={requested_label}");
    if let Some(webview) = app.get_webview(&requested_label) {
        let _ = webview.set_focus();
    }

    *state
        .active_label
        .lock()
        .map_err(|_| "webview state unavailable")? = Some(requested_label.clone());
    *state
        .visible
        .lock()
        .map_err(|_| "webview state unavailable")? = true;
    touch_label(&state, &requested_label)?;
    drop(operation);
    Ok(())
}

pub fn close<R: Runtime>(
    app: &AppHandle<R>,
    account_id: Option<String>,
    provider: Option<String>,
) -> Result<(), String> {
    let state = app.state::<WebviewManager>();
    let operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let active_label = state
        .active_label
        .lock()
        .map_err(|_| "webview state unavailable")?
        .clone();
    if let Some(active) = active_label {
        let matches = match (&account_id, &provider) {
            (Some(id), prov) => {
                // Hanya sembunyikan jika label aktif milik akun+provider yang diminta.
                // Jika provider tidak dikirim (frontend lama), cocokkan akhiran label.
                let suffix = format!("-{id}");
                if let Some(p) = prov {
                    active == webview_label(&normalize_provider(Some(p.clone())), id)
                } else {
                    active.ends_with(&suffix)
                }
            }
            (None, _) => true,
        };
        if matches {
            if let Some(webview) = app.get_webview(&active) {
                webview.hide().map_err(|e| e.to_string())?;
            }
        }
    }
    *state
        .visible
        .lock()
        .map_err(|_| "webview state unavailable")? = false;
    drop(operation);
    Ok(())
}

pub fn resize<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    provider: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_bounds(x, y, width, height)?;
    let provider = normalize_provider(provider);
    let state = app.state::<WebviewManager>();
    let active_label = state
        .active_label
        .lock()
        .map_err(|_| "webview state unavailable")?
        .clone();
    if active_label.as_deref() != Some(webview_label(&provider, &account_id).as_str()) {
        return Ok(());
    }
    if let Some(webview) = app.get_webview(&webview_label(&provider, &account_id)) {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn remove<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    provider: Option<String>,
) -> Result<bool, String> {
    validate_account_id(&account_id)?;
    let provider = normalize_provider(provider);
    let state = app.state::<WebviewManager>();
    // Profil ikut dihapus -> lepas klaim registrasi extension-nya.
    if let Ok(profile) = profile_path(app, &provider, &account_id) {
        let _ = release_ext_registration(&state, &profile);
    }
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    let label = webview_label(&provider, &account_id);

    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    {
        let mut cached = state
            .cached_labels
            .lock()
            .map_err(|_| "webview state unavailable")?;
        cached.remove(&label);
    }
    {
        let mut active = state
            .active_label
            .lock()
            .map_err(|_| "webview state unavailable")?;
        if active.as_deref() == Some(label.as_str()) {
            *active = None;
            *state
                .visible
                .lock()
                .map_err(|_| "webview state unavailable")? = false;
        }
    }

    let profile = profile_path(app, &provider, &account_id)?;
    if !profile.exists() {
        // Fallback: profil model lama (tanpa subfolder provider).
        let legacy = app
            .path()
            .resolve("webview-profiles", BaseDirectory::AppLocalData)
            .map_err(|e| e.to_string())?
            .join(&account_id);
        if legacy.exists() {
            match std::fs::remove_dir_all(&legacy) {
                Ok(()) => return Ok(true),
                Err(error) => {
                    eprintln!("[flowmanager-webview] profile cleanup pending account={account_id}: {error}");
                    return Ok(false);
                }
            }
        }
        return Ok(true);
    }
    match std::fs::remove_dir_all(&profile) {
        Ok(()) => Ok(true),
        Err(error) => {
            eprintln!("[flowmanager-webview] profile cleanup pending account={account_id}: {error}");
            Ok(false)
        }
    }
}

// ===== Panel ekstensi AUTOFLOW =====
// ID stabil dari field "key" di manifest extension.
const EXTENSION_ID: &str = "debadkiomlbdambamdpdlgdkgnedcjil";
const EXTENSION_PANEL_PAGE: &str = "sidepanel/sidepanel.html";

fn ext_panel_label(provider: &str, account_id: &str) -> String {
    format!("extpanel-{}-{account_id}", label_prefix(provider))
}

fn ext_panel_url(page: Option<String>) -> Result<WebviewUrl, String> {
    let page = page.unwrap_or_default();
    let trimmed = page.trim();
    let url_str = if trimmed.is_empty() {
        format!("chrome-extension://{EXTENSION_ID}/{EXTENSION_PANEL_PAGE}")
    } else if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!(
            "chrome-extension://{EXTENSION_ID}/{}",
            trimmed.trim_start_matches('/')
        )
    };
    url_str
        .parse()
        .map(WebviewUrl::External)
        .map_err(|_| "invalid extension page URL".to_string())
}

fn allow_panel_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https" || url.scheme() == "chrome-extension"
}

/// Buka/tampilkan panel ekstensi sebagai dock kanan.
/// Memakai profil data_directory yang SAMA dengan webview provider agar
/// extension, storage, dan tabs-nya berbagi konteks.
pub fn open_ext_panel<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    provider: Option<String>,
    page: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let state = app.state::<WebviewManager>();
    let operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    validate_account_id(&account_id)?;
    validate_bounds(x, y, width, height)?;
    let provider = normalize_provider(provider);
    let label = ext_panel_label(&provider, &account_id);
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        let _ = webview.set_focus();
        touch_label(&state, &label)?;
        return Ok(());
    }

    let profile = profile_path(app, &provider, &account_id)?;
    let mut builder = WebviewBuilder::new(label.clone(), ext_panel_url(page)?)
        .data_directory(profile.clone())
        .browser_extensions_enabled(true)
        .on_navigation(allow_panel_navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    if claim_ext_registration(&state, &profile)? {
        #[cfg(debug_assertions)]
        eprintln!("[fm-ext] registering extensions for {}", profile.display());
        builder = builder.extensions_path(ensure_extensions(app)?);
    } else {
        #[cfg(debug_assertions)]
        eprintln!("[fm-ext] extensions already registered, skip reload");
    }

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    touch_label(&state, &label)?;
    drop(operation);
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_focus();
    }
    Ok(())
}

pub fn close_ext_panel<R: Runtime>(
    app: &AppHandle<R>,
    account_id: Option<String>,
    provider: Option<String>,
) -> Result<(), String> {
    let state = app.state::<WebviewManager>();
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "webview state unavailable")?;
    match (&account_id, &provider) {
        (Some(id), Some(p)) => {
            let label = ext_panel_label(&normalize_provider(Some(p.clone())), id);
            if let Some(wv) = app.get_webview(&label) {
                wv.hide().map_err(|e| e.to_string())?;
            }
        }
        (Some(id), None) => {
            for prefix in ["google-flow", "dola", "migoo", "chatgpt", "minimax", "leonardo", "custom"] {
                let candidate = format!("extpanel-{prefix}-{id}");
                if let Some(wv) = app.get_webview(&candidate) {
                    wv.hide().map_err(|e| e.to_string())?;
                }
            }
        }
        (None, _) => {
            for (label, _) in state
                .cached_labels
                .lock()
                .map_err(|_| "webview state unavailable")?
                .clone()
            {
                if label.starts_with("extpanel-") {
                    if let Some(wv) = app.get_webview(&label) {
                        let _ = wv.hide();
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn resize_ext_panel<R: Runtime>(
    app: &AppHandle<R>,
    account_id: String,
    provider: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_bounds(x, y, width, height)?;
    let provider = normalize_provider(provider);
    let label = ext_panel_label(&provider, &account_id);
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
