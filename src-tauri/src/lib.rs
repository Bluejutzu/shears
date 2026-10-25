mod ffmpeg;
mod store;

use std::path::Path;

#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

#[tauri::command]
fn reveal(path: String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{path}\"")).spawn();
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").args(["-R", &path]).spawn();
    #[cfg(target_os = "linux")]
    if let Some(dir) = Path::new(&path).parent() {
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
}

#[tauri::command]
fn open_folder(path: String) {
    let _ = std::fs::create_dir_all(&path);
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
}

#[derive(serde::Serialize)]
struct AppInfo {
    name: String,
    version: String,
    /// "release" for the public build (updates from GitHub), "dev" for local builds
    channel: &'static str,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let c = app.config();
    // local builds use the ".dev" identity so they live next to the public one
    let dev = cfg!(debug_assertions) || c.identifier.ends_with(".dev");
    AppInfo {
        name: c.product_name.clone().unwrap_or_else(|| "Shears".into()),
        version: app.package_info().version.to_string(),
        channel: if dev { "dev" } else { "release" },
    }
}

/// Opens a web page in the default browser (only http(s) links).
#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

#[tauri::command]
fn unique_path(path: String) -> String {
    let p = Path::new(&path);
    if !p.exists() {
        return path;
    }
    let dir = p.parent().unwrap_or(Path::new(""));
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|c| !c.exists()).map(|c| c.to_string_lossy().into_owned()).unwrap_or(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ffmpeg::Jobs::default())
        .manage(store::Store::default())
        .invoke_handler(tauri::generate_handler![
            initial_file,
            app_info,
            open_url,
            reveal,
            open_folder,
            unique_path,
            store::load_state,
            store::save_settings,
            store::save_recents,
            store::load_edit,
            store::save_edit,
            store::forget_edits,
            store::cache_size,
            store::clear_cache,
            ffmpeg::tools,
            ffmpeg::probe,
            ffmpeg::probe_audio,
            ffmpeg::waveform,
            ffmpeg::extract_audio,
            ffmpeg::thumbnail,
            ffmpeg::list_media,
            ffmpeg::media_info,
            ffmpeg::save_frame,
            ffmpeg::make_preview,
            ffmpeg::export,
            ffmpeg::cancel,
            ffmpeg::read_tags,
            ffmpeg::write_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
