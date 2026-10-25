//! Settings, recents, remembered edits and the cache folder.
//!
//! settings.json lives in the app config dir, recents.json and edits/ in the app data dir,
//! and generated files (thumbnails, preview copies, extracted audio) in the cache dir,
//! which the user can move somewhere else.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Default)]
pub struct Store {
    cache_dir: Mutex<Option<PathBuf>>,
}

const MAX_EDITS: usize = 300;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(err)
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(err)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    // write next to it first so a crash mid-write can't leave a half-written file
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

/// Stable id for a file that changes when the file itself changes (size or modified time).
pub fn file_key(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    if let Ok(m) = std::fs::metadata(path) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

pub fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let custom = app
        .try_state::<Store>()
        .and_then(|s| s.cache_dir.lock().unwrap().clone());
    let dir = match custom {
        Some(d) => d,
        None => app.path().app_cache_dir().map_err(err)?,
    };
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn apply_cache_dir<R: Runtime>(app: &AppHandle<R>, settings: &Value) {
    let dir = settings["cacheDir"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    if let Some(store) = app.try_state::<Store>() {
        *store.cache_dir.lock().unwrap() = dir;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    settings: String,
    data: String,
    cache: String,
    default_cache: String,
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Value, String> {
    let settings = read_json(&config_dir(&app)?.join("settings.json")).unwrap_or(json!({}));
    let recents = read_json(&data_dir(&app)?.join("recents.json")).unwrap_or(json!([]));
    apply_cache_dir(&app, &settings);
    let paths = Paths {
        settings: config_dir(&app)?.join("settings.json").to_string_lossy().into(),
        data: data_dir(&app)?.to_string_lossy().into(),
        cache: cache_dir(&app)?.to_string_lossy().into(),
        default_cache: app.path().app_cache_dir().map_err(err)?.to_string_lossy().into(),
    };
    Ok(json!({ "settings": settings, "recents": recents, "paths": paths }))
}

/// Saves settings and returns the cache folder now in use.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Value) -> Result<String, String> {
    write_json(&config_dir(&app)?.join("settings.json"), &settings)?;
    apply_cache_dir(&app, &settings);
    Ok(cache_dir(&app)?.to_string_lossy().into())
}

#[tauri::command]
pub fn save_recents(app: AppHandle, recents: Value) -> Result<(), String> {
    write_json(&data_dir(&app)?.join("recents.json"), &recents)
}

#[tauri::command]
pub fn load_edit(app: AppHandle, path: String) -> Result<Option<Value>, String> {
    Ok(read_json(&data_dir(&app)?.join("edits").join(format!("{}.json", file_key(&path)))))
}

#[tauri::command]
pub fn save_edit(app: AppHandle, path: String, edit: Option<Value>) -> Result<(), String> {
    let dir = data_dir(&app)?.join("edits");
    let file = dir.join(format!("{}.json", file_key(&path)));
    let Some(edit) = edit else {
        let _ = std::fs::remove_file(file);
        return Ok(());
    };
    write_json(&file, &edit)?;
    prune_oldest(&dir, MAX_EDITS);
    Ok(())
}

#[tauri::command]
pub fn forget_edits(app: AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(data_dir(&app)?.join("edits"));
    Ok(())
}

fn prune_oldest(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// Only files Shears made itself: hash-named files and export temp folders.
/// The cache can point at any folder, so never touch anything else in it.
fn is_ours(name: &str) -> bool {
    name.starts_with("export-")
        || (name.len() > 16 && name.as_bytes()[..16].iter().all(u8::is_ascii_hexdigit))
}

fn our_entries(dir: &Path) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|e| is_ours(&e.file_name().to_string_lossy()))
                .collect()
        })
        .unwrap_or_default()
}

fn size_of(path: &Path) -> u64 {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => std::fs::read_dir(path)
            .map(|it| it.flatten().map(|e| size_of(&e.path())).sum())
            .unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

#[tauri::command]
pub fn cache_size(app: AppHandle) -> Result<u64, String> {
    Ok(our_entries(&cache_dir(&app)?).iter().map(|e| size_of(&e.path())).sum())
}

#[tauri::command]
pub fn clear_cache(app: AppHandle) -> Result<(), String> {
    for e in our_entries(&cache_dir(&app)?) {
        let p = e.path();
        let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
    }
    Ok(())
}
