use crate::store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Default)]
pub struct Jobs {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
}

fn find_bin(name: &str) -> Option<PathBuf> {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(dir);
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    // winget puts its shims here, and apps started before a re-login won't have it on PATH yet
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
    }
    dirs.into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

fn bin(name: &'static str) -> Result<PathBuf, String> {
    static FFMPEG: OnceLock<Option<PathBuf>> = OnceLock::new();
    static FFPROBE: OnceLock<Option<PathBuf>> = OnceLock::new();
    let cell = if name == "ffmpeg" { &FFMPEG } else { &FFPROBE };
    cell.get_or_init(|| find_bin(name)).clone().ok_or_else(|| format!("{name} wasn't found. Install it with: winget install Gyan.FFmpeg"))
}

fn command(path: &Path) -> Command {
    let mut c = Command::new(path);
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn secs(t: f64) -> String {
    format!("{t:.6}")
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn last_lines(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return "ffmpeg failed".into();
    }
    lines[lines.len().saturating_sub(4)..].join("\n")
}

fn cache_file<R: Runtime>(app: &AppHandle<R>, path: &str, suffix: &str) -> Result<PathBuf, String> {
    Ok(store::cache_dir(app)?.join(format!("{}{suffix}", store::file_key(path))))
}

fn detect_encoder() -> String {
    static ENC: OnceLock<String> = OnceLock::new();
    ENC.get_or_init(|| {
        let Ok(ffmpeg) = bin("ffmpeg") else {
            return "libx264".into();
        };
        // the encoder list includes every vendor, so actually try a tiny encode to see which gpu is real
        for enc in ["h264_nvenc", "h264_qsv", "h264_amf"] {
            let ok = command(&ffmpeg)
                .args(["-hide_banner", "-v", "error", "-f", "lavfi"])
                .args(["-i", "color=c=black:s=256x256:r=30:d=0.2"])
                .args(["-c:v", enc, "-f", "null", "-"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if ok {
                return enc.into();
            }
        }
        "libx264".into()
    })
    .clone()
}

#[derive(Serialize)]
pub struct Tools {
    ffmpeg: Option<String>,
    encoder: String,
}

#[tauri::command]
pub async fn tools() -> Result<Tools, String> {
    blocking(|| Ok(Tools { ffmpeg: bin("ffmpeg").ok().map(|p| path_str(&p)), encoder: detect_encoder() })).await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    codec: String,
    channels: u32,
    title: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    vcodec: String,
    acodec: Option<String>,
    audio_tracks: u32,
    audio: Vec<AudioStream>,
    /// rotation stored in the file's display matrix, degrees counter-clockwise
    rotation: f64,
    size: u64,
    container: String,
}

fn ratio(s: &str) -> f64 {
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(0.0));
            if b > 0.0 {
                a / b
            } else {
                0.0
            }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

fn num<T: std::str::FromStr>(v: &Value) -> Option<T> {
    v.as_str().and_then(|s| s.parse().ok())
}

fn ffprobe_json(path: &str, args: &[&str]) -> Result<Value, String> {
    let out = command(&bin("ffprobe")?).args(["-v", "error", "-of", "json"]).args(args).arg(path).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(last_lines(&String::from_utf8_lossy(&out.stderr)));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

fn read_probe(path: &str) -> Result<Probe, String> {
    let v = ffprobe_json(path, &["-show_format", "-show_streams"])?;
    let mut p = Probe {
        duration: num(&v["format"]["duration"]).unwrap_or(0.0),
        size: num(&v["format"]["size"]).unwrap_or(0),
        container: v["format"]["format_name"].as_str().unwrap_or("").into(),
        ..Default::default()
    };
    for s in v["streams"].as_array().into_iter().flatten() {
        match s["codec_type"].as_str() {
            Some("video") if p.vcodec.is_empty() && s["disposition"]["attached_pic"].as_i64() != Some(1) => {
                p.vcodec = s["codec_name"].as_str().unwrap_or("").into();
                p.width = s["width"].as_u64().unwrap_or(0) as u32;
                p.height = s["height"].as_u64().unwrap_or(0) as u32;
                p.fps = ratio(s["avg_frame_rate"].as_str().unwrap_or(""));
                if p.fps <= 0.0 || p.fps > 1000.0 {
                    p.fps = ratio(s["r_frame_rate"].as_str().unwrap_or(""));
                }
                if p.duration <= 0.0 {
                    p.duration = num(&s["duration"]).unwrap_or(0.0);
                }
                p.rotation = s["side_data_list"].as_array().into_iter().flatten().find_map(|d| d["rotation"].as_f64()).unwrap_or(0.0);
            }
            Some("audio") => {
                p.audio_tracks += 1;
                let codec: String = s["codec_name"].as_str().unwrap_or("").into();
                if p.acodec.is_none() {
                    p.acodec = Some(codec.clone());
                }
                p.audio.push(AudioStream {
                    codec,
                    channels: s["channels"].as_u64().unwrap_or(2) as u32,
                    title: s["tags"]["title"]
                        .as_str()
                        .or(s["tags"]["handler_name"].as_str().filter(|h| !h.contains("Handler")))
                        .map(Into::into),
                });
                if p.duration <= 0.0 {
                    p.duration = num(&s["duration"]).unwrap_or(0.0);
                }
            }
            _ => {}
        }
    }
    Ok(p)
}

#[tauri::command]
pub async fn probe(path: String) -> Result<Probe, String> {
    blocking(move || {
        let p = read_probe(&path)?;
        if p.vcodec.is_empty() {
            return Err("No video stream in this file".into());
        }
        Ok(p)
    })
    .await
}

/// Probe for a file that gets added as an extra audio track (music, voiceover, ...).
#[tauri::command]
pub async fn probe_audio(path: String) -> Result<Probe, String> {
    blocking(move || {
        let p = read_probe(&path)?;
        if p.audio.is_empty() {
            return Err("That file has no audio".into());
        }
        Ok(p)
    })
    .await
}

/// Audio peaks, 100 per second, 0-255.
#[tauri::command]
pub async fn waveform(path: String, track: u32) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        let out = command(&bin("ffmpeg")?)
            .args(["-hide_banner", "-v", "error", "-i"])
            .arg(&path)
            .args(["-map", &format!("0:a:{track}"), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
            .stderr(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        let peaks: Vec<u8> = out
            .stdout
            .chunks(160)
            .map(|c| {
                let max = c.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs()).max().unwrap_or(0);
                ((max as f32 / 32768.0).sqrt() * 255.0) as u8
            })
            .collect();
        Ok(tauri::ipc::Response::new(peaks))
    })
    .await
}

/// Pulls one audio track out into its own file so the player can control each track separately.
#[tauri::command]
pub async fn extract_audio(app: AppHandle, path: String, track: u32, codec: String) -> Result<String, String> {
    blocking(move || {
        let out = cache_file(&app, &path, &format!("-a{track}.m4a"))?;
        if out.exists() {
            return Ok(path_str(&out));
        }
        let tmp = out.with_extension("part.m4a");
        let attempt = |copy: bool| {
            command(&bin("ffmpeg")?)
                .args(["-hide_banner", "-v", "error", "-y", "-i"])
                .arg(&path)
                .args(["-map", &format!("0:a:{track}"), "-vn"])
                .args(if copy { &["-c:a", "copy"][..] } else { &["-c:a", "aac", "-b:a", "192k"] })
                .arg(&tmp)
                .status()
                .map(|s| s.success())
                .map_err(|e| e.to_string())
        };
        // copying is instant, but only works for codecs the player can read inside m4a
        let copyable = matches!(codec.as_str(), "aac" | "mp3" | "opus" | "flac" | "alac");
        let copied = copyable && attempt(true)?;
        if !copied && !attempt(false)? {
            let _ = std::fs::remove_file(&tmp);
            return Err("Couldn't read this audio track".into());
        }
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        Ok(path_str(&out))
    })
    .await
}

fn make_thumb<R: Runtime>(app: &AppHandle<R>, path: &str, at: f64) -> Result<String, String> {
    let out = cache_file(app, path, ".jpg")?;
    if out.exists() {
        return Ok(path_str(&out));
    }
    let grab = |at: f64| -> Result<bool, String> {
        Ok(command(&bin("ffmpeg")?)
            .args(["-hide_banner", "-v", "error", "-y", "-ss", &secs(at), "-i"])
            .arg(path)
            .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"])
            .arg(&out)
            .status()
            .is_ok_and(|s| s.success())
            && out.exists())
    };
    // very short clips may not reach `at`, so fall back to the first frame
    if grab(at)? || grab(0.0)? {
        Ok(path_str(&out))
    } else {
        Err("Couldn't grab a thumbnail".into())
    }
}

#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: String, at: f64) -> Result<String, String> {
    blocking(move || make_thumb(&app, &path, at)).await
}

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "wmv", "mts", "m2ts", "3gp"];

#[derive(Serialize)]
pub struct MediaFile {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

/// Videos directly inside a folder, newest first. Used for the media pool's watched folders.
#[tauri::command]
pub async fn list_media(dir: String) -> Result<Vec<MediaFile>, String> {
    blocking(move || {
        let mut files: Vec<MediaFile> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let ext = p.extension()?.to_string_lossy().to_lowercase();
                let meta = e.metadata().ok()?;
                if !meta.is_file() || !VIDEO_EXTS.contains(&ext.as_str()) {
                    return None;
                }
                let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
                Some(MediaFile { path: path_str(&p), name: p.file_name()?.to_string_lossy().into(), size: meta.len(), modified })
            })
            .collect();
        files.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(files)
    })
    .await
}

#[derive(Serialize)]
pub struct MediaInfo {
    duration: f64,
    thumb: Option<String>,
}

#[tauri::command]
pub async fn media_info(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    blocking(move || {
        let v = ffprobe_json(&path, &["-show_entries", "format=duration"])?;
        let duration: f64 = num(&v["format"]["duration"]).unwrap_or(0.0);
        let thumb = make_thumb(&app, &path, (duration * 0.1).min(5.0)).ok();
        Ok(MediaInfo { duration, thumb })
    })
    .await
}

#[tauri::command]
pub async fn save_frame(input: String, time: f64, output: String, rotate: u32, flip: bool) -> Result<(), String> {
    blocking(move || {
        if let Some(dir) = Path::new(&output).parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut cmd = command(&bin("ffmpeg")?);
        cmd.args(["-hide_banner", "-v", "error", "-y", "-ss", &secs(time), "-i"]).arg(&input).args(["-frames:v", "1"]);
        let vf = video_filters(rotate, flip);
        if !vf.is_empty() {
            cmd.args(["-vf", vf.trim_end_matches(',')]);
        }
        let out = cmd.arg(&output).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(last_lines(&String::from_utf8_lossy(&out.stderr)))
        }
    })
    .await
}

#[derive(Serialize, Clone)]
struct Progress {
    /// 0..1 across the whole job
    p: f64,
    /// frames per second ffmpeg is currently processing
    fps: f64,
    /// how many times faster than realtime
    speed: f64,
}

/// Runs ffmpeg and reports progress as `base + done * weight` (0..1) on the "job-progress" event.
fn run<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, args: &[String], total: f64, base: f64, weight: f64) -> Result<(), String> {
    if jobs.cancelled.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    let mut child = command(&bin("ffmpeg")?)
        .args(["-hide_banner", "-v", "error", "-y", "-nostats", "-stats_period", "0.25", "-progress", "pipe:1"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    *jobs.child.lock().unwrap() = Some(child);

    let (mut fps, mut speed) = (0.0, 0.0);
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(v) = line.strip_prefix("fps=") {
            fps = v.trim().parse().unwrap_or(fps);
        } else if let Some(v) = line.strip_prefix("speed=") {
            speed = v.trim().trim_end_matches('x').parse().unwrap_or(speed);
        } else if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
            let done = (us / 1e6 / total).clamp(0.0, 1.0);
            let _ = app.emit("job-progress", Progress { p: base + done * weight, fps, speed });
        }
    }

    let child = jobs.child.lock().unwrap().take();
    let stderr = errors.join().unwrap_or_default();
    let Some(mut child) = child else {
        return Err("Cancelled".into());
    };
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(last_lines(&stderr))
    }
}

#[tauri::command]
pub fn cancel(jobs: State<Jobs>) {
    jobs.cancelled.store(true, Ordering::SeqCst);
    if let Some(mut c) = jobs.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn encoder_args(enc: &str, kbps: Option<f64>) -> Vec<String> {
    // gpu encoders can't always get down to low bitrates and overshoot, so size limits always use x264
    let gpu = kbps.is_none() && matches!(enc, "h264_nvenc" | "h264_qsv" | "h264_amf");
    let enc = if gpu { enc } else { "libx264" };
    let mut a = strs(&["-c:v", enc]);
    a.extend(strs(match enc {
        "h264_nvenc" => &["-preset", "p5"][..],
        "h264_qsv" => &["-preset", "medium"],
        "h264_amf" => &["-quality", "balanced"],
        _ => &["-preset", "veryfast"],
    }));
    match kbps {
        Some(k) => {
            let k = k.round();
            a.extend(strs(&["-b:v", &format!("{k}k"), "-maxrate", &format!("{k}k"), "-bufsize", &format!("{}k", k * 2.0)]));
        }
        None => a.extend(strs(match enc {
            "h264_nvenc" => &["-rc", "vbr", "-cq", "22", "-b:v", "0"][..],
            "h264_qsv" => &["-global_quality", "22"],
            "h264_amf" => &["-rc", "cqp", "-qp_i", "20", "-qp_p", "22"],
            _ => &["-crf", "20"],
        })),
    }
    a
}

#[tauri::command]
pub async fn make_preview(app: AppHandle, input: String, duration: f64, transcode: bool) -> Result<String, String> {
    blocking(move || {
        let jobs = app.state::<Jobs>();
        jobs.cancelled.store(false, Ordering::SeqCst);
        let out = cache_file(&app, &input, if transcode { "-proxy.mp4" } else { "-remux.mp4" })?;
        if out.exists() {
            return Ok(path_str(&out));
        }
        let tmp = out.with_extension("part.mp4");
        let mut args = strs(&["-i", &input, "-map", "0:v:0", "-map", "0:a:0?"]);
        if transcode {
            args.extend(strs(&["-vf", "scale=-2:'min(720,ih)',format=yuv420p"]));
            args.extend(encoder_args(&detect_encoder(), None));
        } else {
            args.extend(strs(&["-c:v", "copy"]));
        }
        args.extend(strs(&["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]));
        args.push(path_str(&tmp));
        if let Err(e) = run(&app, &jobs, &args, duration.max(0.1), 0.0, 1.0) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        prune_previews(&out);
        Ok(path_str(&out))
    })
    .await
}

/// Preview copies can be as big as the source, so only keep the few most recent ones.
fn prune_previews(keep: &Path) {
    let Some(dir) = keep.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut previews: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            name.ends_with("-remux.mp4") || name.ends_with("-proxy.mp4")
        })
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    previews.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in previews.into_iter().skip(3) {
        if p != keep {
            let _ = std::fs::remove_file(p);
        }
    }
}

// ---- export

/// One audio track going into the export: a track of the main video (`path: None`)
/// or a separate file placed at `offset` seconds on the source timeline.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    path: Option<String>,
    track: u32,
    offset: f64,
    gain_db: f64,
}

/// An image laid over the video from `start` to `end` (source timeline seconds).
/// `x`/`y` are its center and `scale` its width, all as fractions of the frame.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    path: String,
    start: f64,
    end: f64,
    x: f64,
    y: f64,
    scale: f64,
    opacity: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    input: String,
    output: String,
    segments: Vec<[f64; 2]>,
    copy: bool,
    encoder: String,
    /// "mix" | "separate" | "none"
    audio: String,
    /// unmuted tracks only
    sources: Vec<AudioSource>,
    height: Option<u32>,
    target_mb: Option<f64>,
    /// clockwise degrees: 0, 90, 180 or 270
    rotate: u32,
    flip: bool,
    source_rotation: f64,
    /// bottom first; only used when re-encoding
    #[serde(default)]
    overlays: Vec<Overlay>,
    #[serde(default)]
    metadata: MetaEdit,
    /// the tag args, worked out once (it needs an ffprobe)
    #[serde(skip)]
    meta: OnceLock<(Vec<String>, bool)>,
}

fn video_filters(rotate: u32, flip: bool) -> String {
    let mut f = String::new();
    if flip {
        f.push_str("hflip,");
    }
    f.push_str(match rotate {
        90 => "transpose=1,",
        180 => "hflip,vflip,",
        270 => "transpose=2,",
        _ => "",
    });
    f
}

impl ExportJob {
    fn ext(&self) -> String {
        Path::new(&self.output).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "mp4".into())
    }

    /// Output options every written file gets: the tags, and for mp4/mov the moov atom up front.
    fn finish(&self, args: &mut Vec<String>) {
        let ext = self.ext();
        let (meta, mdta) = self.meta.get_or_init(|| meta_args(&self.input, &ext, &self.metadata));
        args.extend(meta.iter().cloned());
        args.extend(movflags(&ext, *mdta));
    }

    /// Output audio streams, each a list of sources mixed together.
    fn mixes(&self) -> Vec<Vec<AudioSource>> {
        match self.audio.as_str() {
            "none" => vec![],
            "separate" => self.sources.iter().map(|s| vec![s.clone()]).collect(),
            _ if self.sources.is_empty() => vec![],
            _ => vec![self.sources.clone()],
        }
    }

    /// When the audio doesn't need any processing, the source tracks can just be copied.
    fn copyable_tracks(&self) -> Option<Vec<u32>> {
        let mixes = self.mixes();
        if mixes.is_empty() {
            return Some(vec![]);
        }
        let plain = |s: &AudioSource| s.path.is_none() && s.gain_db.abs() < 0.01;
        (self.audio == "separate" && self.sources.iter().all(plain)).then(|| self.sources.iter().map(|s| s.track).collect())
    }

    /// Fast copy can't touch pixels, so rotation/flip go into the file's display metadata instead.
    fn display_args(&self) -> Vec<String> {
        if self.rotate == 0 && !self.flip {
            return vec![];
        }
        let ccw = (self.source_rotation - self.rotate as f64).rem_euclid(360.0);
        let mut a = strs(&["-display_rotation:v:0", &format!("{ccw}")]);
        if self.flip {
            a.push("-display_hflip:v:0".into());
        }
        a
    }
}

#[derive(Default)]
struct Inputs {
    args: Vec<String>,
    count: usize,
}

impl Inputs {
    fn add(&mut self, args: Vec<String>) -> usize {
        self.args.extend(args);
        self.count += 1;
        self.count - 1
    }

    fn seek(&mut self, input: &str, s: [f64; 2]) -> usize {
        self.add(strs(&["-ss", &secs(s[0]), "-t", &secs(s[1] - s[0]), "-i", input]))
    }
}

fn audio_chain(gain_db: f64) -> String {
    format!("aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={gain_db:.2}dB")
}

/// Adds the audio for every segment to the filter graph. Returns, per segment, one label per output stream.
/// `main[i]` is the input index of segment i's seeked copy of the main video.
fn audio_graph(job: &ExportJob, segs: &[[f64; 2]], main: &[usize], inputs: &mut Inputs, graph: &mut String) -> Vec<Vec<String>> {
    let mut out = vec![Vec::new(); segs.len()];
    for (m, sources) in job.mixes().iter().enumerate() {
        let mut parts: Vec<Vec<String>> = vec![Vec::new(); segs.len()];
        for (si, src) in sources.iter().enumerate() {
            match &src.path {
                None => {
                    for (i, input) in main.iter().enumerate() {
                        let l = format!("m{m}s{si}i{i}");
                        graph.push_str(&format!("[{input}:a:{}]{}[{l}];", src.track, audio_chain(src.gain_db)));
                        parts[i].push(l);
                    }
                }
                Some(path) => {
                    // which bits of the added file land inside each kept segment
                    let hits: Vec<(usize, f64, f64, f64)> = segs
                        .iter()
                        .enumerate()
                        .filter_map(|(i, s)| {
                            let rel = s[0] - src.offset;
                            let start = rel.max(0.0);
                            let end = s[1] - src.offset;
                            (end > start + 0.001).then_some((i, start, end, (-rel).max(0.0)))
                        })
                        .collect();
                    if hits.is_empty() {
                        continue;
                    }
                    let input = inputs.add(strs(&["-i", path]));
                    let names: String = hits.iter().map(|h| format!("[x{m}s{si}i{}]", h.0)).collect();
                    graph.push_str(&format!("[{input}:a:{}]asplit={}{names};", src.track, hits.len()));
                    for (i, start, end, delay) in hits {
                        let l = format!("m{m}s{si}i{i}");
                        graph.push_str(&format!(
                            "[x{m}s{si}i{i}]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS,adelay={:.0}:all=1,{}[{l}];",
                            delay * 1000.0,
                            audio_chain(src.gain_db)
                        ));
                        parts[i].push(l);
                    }
                }
            }
        }
        for (i, s) in segs.iter().enumerate() {
            let d = s[1] - s[0];
            let l = format!("a{i}m{m}");
            let ins: String = parts[i].iter().map(|x| format!("[{x}]")).collect();
            let fit = format!("apad,atrim=duration={d:.6},asetpts=PTS-STARTPTS[{l}];");
            match parts[i].len() {
                0 => graph.push_str(&format!("anullsrc=r=48000:cl=stereo,atrim=duration={d:.6}[{l}];")),
                1 => graph.push_str(&format!("{ins}{fit}")),
                k => graph.push_str(&format!("{ins}amix=inputs={k}:normalize=0:duration=longest,{fit}")),
            }
            out[i].push(l);
        }
    }
    out
}

// ---- metadata

/// Tag changes on top of the file's own: `Some` sets a tag, `None` (or blank) removes it.
/// `strip` drops every tag instead.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetaEdit {
    #[serde(default)]
    strip: bool,
    #[serde(default)]
    tags: Vec<(String, Option<String>)>,
}

// tags that describe the container or get written by ffmpeg itself
const TECHNICAL: &[&str] = &["major_brand", "minor_version", "compatible_brands", "encoder", "location-eng"];

fn is_mov(ext: &str) -> bool {
    matches!(ext, "mp4" | "mov" | "m4v")
}

/// Container-level tags. When a file has a tag twice (mov keeps some in two places),
/// ffprobe joins them with ";" so those get split back to the first one.
fn read_tags_of(path: &str) -> BTreeMap<String, String> {
    let Ok(v) = ffprobe_json(path, &["-show_entries", "format_tags"]) else {
        return BTreeMap::new();
    };
    let doubled = ["creation_time", "major_brand", "minor_version", "compatible_brands"];
    v["format"]["tags"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| {
            let v = v.as_str()?;
            let v = if doubled.contains(&k.as_str()) { v.split(';').next().unwrap_or(v) } else { v };
            Some((k.clone(), v.to_string()))
        })
        .collect()
}

#[tauri::command]
pub async fn read_tags(path: String) -> Result<BTreeMap<String, String>, String> {
    blocking(move || Ok(read_tags_of(&path))).await
}

/// ffmpeg args that put the edited tags on an output, and whether mp4/mov needs to write
/// them as "mdta" keys (the Apple-style com.apple.quicktime.* ones phones use for location and device).
fn meta_args(input: &str, ext: &str, edit: &MetaEdit) -> (Vec<String>, bool) {
    let dotted = |k: &String| k.contains('.');
    if edit.strip {
        return (strs(&["-map_metadata", "-1"]), false);
    }
    let orig = read_tags_of(input);
    if edit.tags.is_empty() {
        // ffmpeg copies the tags by itself, but mp4/mov drops the Apple-style ones without mdta
        return (vec![], is_mov(ext) && orig.keys().any(dotted));
    }
    let mut tags: BTreeMap<String, String> = orig.into_iter().filter(|(k, _)| !TECHNICAL.contains(&k.as_str())).collect();
    for (k, v) in &edit.tags {
        match v.as_deref().map(str::trim) {
            Some(v) if !v.is_empty() => tags.insert(k.clone(), v.to_string()),
            _ => tags.remove(k),
        };
    }
    // replace the file-level tags but keep per-stream ones (track languages, names)
    let mut a = strs(&["-map_metadata:g", "-1"]);
    for (k, v) in &tags {
        a.push("-metadata".into());
        a.push(format!("{k}={v}"));
    }
    (a, is_mov(ext) && tags.keys().any(dotted))
}

fn movflags(ext: &str, mdta: bool) -> Vec<String> {
    match (is_mov(ext), mdta) {
        (true, true) => strs(&["-movflags", "+faststart+use_metadata_tags"]),
        (true, false) => strs(&["-movflags", "+faststart"]),
        _ => vec![],
    }
}

/// Writes edited tags into a copy of the file (video, audio and subtitles copied as-is) and
/// swaps it in for the original, or saves it to `output` when given.
#[tauri::command]
pub async fn write_metadata(input: String, output: Option<String>, edit: MetaEdit) -> Result<(), String> {
    blocking(move || {
        let target = PathBuf::from(output.unwrap_or_else(|| input.clone()));
        let ext = target.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let name = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = target.with_file_name(format!(".{name}.shears-tmp.{ext}"));
        let (meta, mdta) = meta_args(&input, &ext, &edit);
        let out = command(&bin("ffmpeg")?)
            .args(["-hide_banner", "-v", "error", "-y", "-i"])
            .arg(&input)
            .args(["-map", "0:v?", "-map", "0:a?", "-map", "0:s?", "-c", "copy"])
            .args(&meta)
            .args(movflags(&ext, mdta))
            .arg(&tmp)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&tmp);
            return Err(last_lines(&String::from_utf8_lossy(&out.stderr)));
        }
        // the player may take a moment to let go of the file, so retry the swap briefly
        let mut tries = 0;
        loop {
            match std::fs::rename(&tmp, &target) {
                Ok(()) => return Ok(()),
                Err(_) if tries < 20 => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("Couldn't replace the file: {e}"));
                }
            }
        }
    })
    .await
}

/// Width of the exported frame after rotation and scaling, so overlays can be sized in pixels.
fn frame_width(job: &ExportJob) -> f64 {
    let p = read_probe(&job.input).unwrap_or_default();
    let (mut w, mut h) = (p.width as f64, p.height as f64);
    let sideways = |deg: f64| (deg.rem_euclid(180.0) - 90.0).abs() < 1.0;
    if sideways(p.rotation) != sideways(job.rotate as f64) {
        std::mem::swap(&mut w, &mut h);
    }
    match job.height {
        Some(t) if h > 0.0 => (w * t as f64 / h / 2.0).round() * 2.0,
        _ => w,
    }
}

/// Lays each overlay over the kept parts it shows up in. `video[i]` is part i's video label
/// and gets swapped for the label with the overlays on.
fn overlay_graph(job: &ExportJob, segs: &[[f64; 2]], video: &mut [String], inputs: &mut Inputs, graph: &mut String) {
    if job.overlays.is_empty() {
        return;
    }
    let frame_w = frame_width(job);
    for (k, o) in job.overlays.iter().enumerate() {
        // when it shows up inside each part, in that part's own time
        let hits: Vec<(usize, f64, f64)> = segs
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let a = o.start.max(s[0]) - s[0];
                let b = o.end.min(s[1]) - s[0];
                (b > a + 0.001).then_some((i, a, b))
            })
            .collect();
        if hits.is_empty() {
            continue;
        }
        let input = inputs.add(strs(&["-i", &o.path]));
        let w = ((frame_w * o.scale).round() as u32).max(2);
        let names: String = hits.iter().map(|h| format!("[i{k}p{}]", h.0)).collect();
        graph.push_str(&format!(
            "[{input}:v:0]scale={w}:-1,format=rgba,colorchannelmixer=aa={:.3},split={}{names};",
            o.opacity.clamp(0.0, 1.0),
            hits.len()
        ));
        for (i, a, b) in hits {
            let out = format!("o{k}p{i}");
            graph.push_str(&format!(
                "[{}][i{k}p{i}]overlay=x=main_w*{:.4}-overlay_w/2:y=main_h*{:.4}-overlay_h/2:enable='between(t,{a:.3},{b:.3})'[{out}];",
                video[i], o.x, o.y
            ));
            video[i] = out;
        }
    }
}

/// Keyframe times of the main video stream, relative to the start of the file.
fn keyframes(input: &str) -> Result<Vec<f64>, String> {
    let v = ffprobe_json(input, &["-select_streams", "v:0", "-show_entries", "packet=pts_time,flags:format=start_time"])?;
    let start = num::<f64>(&v["format"]["start_time"]).unwrap_or(0.0);
    let mut kf: Vec<f64> = v["packets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["flags"].as_str().is_some_and(|f| f.starts_with('K')))
        .filter_map(|p| num::<f64>(&p["pts_time"]))
        .map(|t| t - start)
        .collect();
    kf.sort_by(|a, b| a.total_cmp(b));
    Ok(kf)
}

/// Fast copy can only start on a keyframe, so move each start back to one ourselves
/// (merging parts that end up overlapping). Returns [keyframe, where to seek, end] per part.
fn snap_to_keyframes(segs: &[[f64; 2]], kf: &[f64]) -> Vec<[f64; 3]> {
    let mut out: Vec<[f64; 3]> = Vec::new();
    for s in segs {
        let i = kf.iter().rposition(|&k| k <= s[0] + 1e-3);
        let start = i.map_or(0.0, |i| kf[i].max(0.0));
        // ffmpeg seeks ~0.13s early in files with b-frames, so aim a little past the keyframe
        // (but never as far as the next one) to make sure it lands on this one
        let gap = i.and_then(|i| kf.get(i + 1)).map_or(1.0, |next| next - start);
        let seek = start + (gap * 0.5).min(0.15);
        match out.last_mut() {
            Some(last) if start <= last[2] + 1e-3 => last[2] = last[2].max(s[1]),
            _ => out.push([start, seek, s[1]]),
        }
    }
    out
}

/// How long a file's video actually is, used to see where a copied part really starts.
fn video_duration(path: &str) -> Option<f64> {
    let v = ffprobe_json(path, &["-select_streams", "v:0", "-show_entries", "stream=duration:format=duration"]).ok()?;
    v["streams"][0]["duration"].as_str().or(v["format"]["duration"].as_str()).and_then(|s| s.parse().ok())
}

fn same_file(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Returns the size of the exported file in bytes.
#[tauri::command]
pub async fn export(app: AppHandle, job: ExportJob) -> Result<u64, String> {
    blocking(move || {
        if job.segments.is_empty() {
            return Err("Nothing left to export".into());
        }
        if same_file(&job.input, &job.output) {
            return Err("Pick a different output file than the source".into());
        }
        if let Some(dir) = Path::new(&job.output).parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let jobs = app.state::<Jobs>();
        jobs.cancelled.store(false, Ordering::SeqCst);
        let result = run_export(&app, &jobs, &job);
        if let Err(e) = result {
            let _ = std::fs::remove_file(&job.output);
            return Err(e);
        }
        Ok(std::fs::metadata(&job.output).map(|m| m.len()).unwrap_or(0))
    })
    .await
}

fn run_export<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, job: &ExportJob) -> Result<(), String> {
    if job.copy {
        let segs = snap_to_keyframes(&job.segments, &keyframes(&job.input)?);
        export_copy(app, jobs, job, &segs)
    } else {
        export_encode(app, jobs, job, &job.segments)
    }
}

fn total(segs: &[[f64; 2]]) -> f64 {
    segs.iter().map(|s| s[1] - s[0]).sum::<f64>().max(0.01)
}

fn export_copy<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, job: &ExportJob, parts: &[[f64; 3]]) -> Result<(), String> {
    let segs: Vec<[f64; 2]> = parts.iter().map(|p| [p[0], p[2]]).collect();
    let total = total(&segs);
    let tracks = job.copyable_tracks();
    let dir = store::cache_dir(app)?.join(format!("export-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = job.ext();
    // with processed audio, the copied video gets a separately rendered audio track muxed in at the end
    let (video_weight, video_out) = match &tracks {
        Some(_) => (1.0, job.output.clone()),
        None => (0.6, path_str(&dir.join(format!("video.{ext}")))),
    };

    let piece = |p: [f64; 3], out: String| {
        let mut a = job.display_args();
        a.extend(strs(&["-ss", &secs(p[1]), "-t", &secs(p[2] - p[1]), "-i", &job.input]));
        a.extend(strs(&["-map", "0:v:0", "-c:v", "copy"]));
        match &tracks {
            Some(t) if !t.is_empty() => {
                for track in t {
                    a.extend(strs(&["-map", &format!("0:a:{track}")]));
                }
                a.extend(strs(&["-c:a", "copy"]));
            }
            _ => a.push("-an".into()),
        }
        a.extend(strs(&["-avoid_negative_ts", "make_zero"]));
        job.finish(&mut a);
        a.push(out);
        a
    };

    // where each copied part really starts, measured afterwards so the audio lines up even if
    // ffmpeg landed on an earlier keyframe than we aimed for
    let mut actual = segs.clone();
    let start_of = |i: usize, file: &str| video_duration(file).map(|d| (parts[i][2] - d).max(0.0));

    let result = (|| {
        if parts.len() == 1 {
            run(app, jobs, &piece(parts[0], video_out.clone()), total, 0.0, video_weight)?;
            if let Some(s) = start_of(0, &video_out) {
                actual[0][0] = s;
            }
        } else {
            let mut list = String::new();
            let mut done = 0.0;
            for (i, p) in parts.iter().enumerate() {
                let part = path_str(&dir.join(format!("part{i}.{ext}"))).replace('\\', "/");
                let len = p[2] - p[0];
                let w = video_weight * 0.95;
                run(app, jobs, &piece(*p, part.clone()), len, done / total * w, len / total * w)?;
                if let Some(s) = start_of(i, &part) {
                    actual[i][0] = s;
                }
                done += len;
                list.push_str(&format!("file '{}'\n", part.replace('\'', "'\\''")));
            }
            let list_path = dir.join("list.txt");
            std::fs::write(&list_path, list).map_err(|e| e.to_string())?;
            let mut a = strs(&["-f", "concat", "-safe", "0", "-i", &path_str(&list_path)]);
            a.extend(strs(&["-map", "0", "-c", "copy"]));
            job.finish(&mut a);
            a.push(video_out.clone());
            run(app, jobs, &a, total, video_weight * 0.95, video_weight * 0.05)?;
        }

        if tracks.is_some() {
            return Ok(());
        }

        let mut inputs = Inputs::default();
        let mut graph = String::new();
        let main: Vec<usize> = actual.iter().map(|s| inputs.seek(&job.input, *s)).collect();
        let audio = audio_graph(job, &actual, &main, &mut inputs, &mut graph);
        let streams = audio[0].len();
        let joined: String = audio.iter().flatten().map(|l| format!("[{l}]")).collect();
        let outs: String = (0..streams).map(|m| format!("[oa{m}]")).collect();
        graph.push_str(&format!("{joined}concat=n={}:v=0:a={streams}{outs}", actual.len()));
        let audio_out = path_str(&dir.join("audio.m4a"));
        let mut a = inputs.args;
        a.extend(strs(&["-filter_complex", &graph]));
        for m in 0..streams {
            a.extend(strs(&["-map", &format!("[oa{m}]")]));
        }
        a.extend(strs(&["-c:a", "aac", "-b:a", "192k", &audio_out]));
        run(app, jobs, &a, total, 0.6, 0.3)?;

        let mut a = strs(&["-i", &video_out, "-i", &audio_out, "-map", "0:v", "-map", "1:a", "-c", "copy"]);
        job.finish(&mut a);
        a.push(job.output.clone());
        run(app, jobs, &a, total, 0.9, 0.1)
    })();

    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn export_encode<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, job: &ExportJob, segs: &[[f64; 2]]) -> Result<(), String> {
    let total = total(segs);
    let mut inputs = Inputs::default();
    let mut graph = String::new();
    // each kept part is its own seeked input, so ffmpeg never decodes the bits we threw away
    let main: Vec<usize> = segs.iter().map(|s| inputs.seek(&job.input, *s)).collect();
    let vf = video_filters(job.rotate, job.flip);
    let scale = job.height.map(|h| format!("scale=-2:{h}:flags=lanczos,")).unwrap_or_default();
    for (i, input) in main.iter().enumerate() {
        graph.push_str(&format!("[{input}:v:0]{vf}{scale}format=yuv420p,setsar=1[v{i}];"));
    }
    let mut video: Vec<String> = (0..segs.len()).map(|i| format!("v{i}")).collect();
    overlay_graph(job, segs, &mut video, &mut inputs, &mut graph);
    let audio = audio_graph(job, segs, &main, &mut inputs, &mut graph);
    let streams = audio[0].len();
    let joined: String = audio
        .iter()
        .enumerate()
        .map(|(i, labels)| format!("[{}]{}", video[i], labels.iter().map(|l| format!("[{l}]")).collect::<String>()))
        .collect();
    let outs: String = (0..streams).map(|m| format!("[oa{m}]")).collect();
    graph.push_str(&format!("{joined}concat=n={}:v=1:a={streams}[v]{outs}", segs.len()));

    let mut args = inputs.args;
    args.extend(strs(&["-filter_complex", &graph, "-map", "[v]"]));
    let audio_kbps = if job.target_mb.is_some() { 128.0 } else { 192.0 };
    for m in 0..streams {
        args.extend(strs(&["-map", &format!("[oa{m}]")]));
    }
    if streams > 0 {
        args.extend(strs(&["-c:a", "aac", "-b:a", &format!("{audio_kbps}k")]));
    }
    // leave a little headroom so we land under the size limit, not just over it
    let video_kbps = job.target_mb.map(|mb| (mb * 8000.0 * 0.94 / total - audio_kbps * streams as f64).max(150.0));
    args.extend(encoder_args(&job.encoder, video_kbps));
    job.finish(&mut args);
    args.push(job.output.clone());
    run(app, jobs, &args, total, 0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Out {
        duration: f64,
        audio: usize,
        width: u64,
        height: u64,
        size: u64,
    }

    fn inspect(path: &Path) -> Out {
        let v = ffprobe_json(&path_str(path), &["-show_entries", "format=duration,size:stream=codec_type,width,height"]).unwrap();
        let streams = v["streams"].as_array().unwrap();
        Out {
            duration: num(&v["format"]["duration"]).unwrap_or(0.0),
            size: num(&v["format"]["size"]).unwrap_or(0),
            audio: streams.iter().filter(|s| s["codec_type"] == "audio").count(),
            width: streams.iter().find_map(|s| s["width"].as_u64()).unwrap_or(0),
            height: streams.iter().find_map(|s| s["height"].as_u64()).unwrap_or(0),
        }
    }

    fn src(track: u32, gain_db: f64) -> AudioSource {
        AudioSource { path: None, track, offset: 0.0, gain_db }
    }

    // runs against real clips: set SHEARS_TEST_DIR to a folder with test-clip.mp4 (90s 1080p, 1 audio track),
    // obs-style.mkv (30s 720p, 2 audio tracks) and beep.mp3 (10s)
    #[test]
    fn exports() {
        let Some(dir) = std::env::var_os("SHEARS_TEST_DIR").map(PathBuf::from) else {
            return;
        };
        let app = tauri::test::mock_app();
        let jobs = Jobs::default();
        let clip = path_str(&dir.join("test-clip.mp4"));
        let mkv = path_str(&dir.join("obs-style.mkv"));
        let beep = AudioSource { path: Some(path_str(&dir.join("beep.mp3"))), track: 0, offset: 5.0, gain_db: -3.0 };
        let enc = detect_encoder();
        let png = dir.join("overlay.png");
        let made = command(&bin("ffmpeg").unwrap())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=1", "-frames:v", "1"])
            .arg(&png)
            .status()
            .unwrap();
        assert!(made.success());
        // a short clip with ordinary and Apple-style tags, like a phone recording
        let tagged = path_str(&dir.join("tagged.mp4"));
        let made = command(&bin("ffmpeg").unwrap())
            .args(["-v", "error", "-y", "-t", "6", "-i", &clip, "-c", "copy", "-movflags", "use_metadata_tags"])
            .args(["-metadata", "title=Old", "-metadata", "artist=Someone", "-metadata", "com.apple.quicktime.make=Apple"])
            .args(["-metadata", "com.apple.quicktime.model=iPhone 16 Pro", &tagged])
            .status()
            .unwrap();
        assert!(made.success());
        let edit = MetaEdit {
            strip: false,
            tags: vec![
                ("title".into(), Some("New".into())),
                ("artist".into(), None),
                ("com.apple.quicktime.location.ISO6709".into(), Some("+52.5200+013.4050/".into())),
            ],
        };
        let edited = vec![
            ("title", Some("New")),
            ("artist", None),
            ("com.apple.quicktime.make", Some("Apple")),
            ("com.apple.quicktime.location.ISO6709", Some("+52.5200+013.4050/")),
        ];
        let logo = Overlay { path: path_str(&png), start: 4.0, end: 12.0, x: 0.75, y: 0.25, scale: 0.3, opacity: 0.8 };

        struct Case {
            name: &'static str,
            input: String,
            copy: bool,
            audio: &'static str,
            sources: Vec<AudioSource>,
            segments: Vec<[f64; 2]>,
            height: Option<u32>,
            target_mb: Option<f64>,
            rotate: u32,
            overlays: Vec<Overlay>,
            metadata: MetaEdit,
            want_tags: Vec<(&'static str, Option<&'static str>)>,
            want: f64,
            tol: f64,
            want_audio: usize,
        }
        let case = |name, input: &String, copy, audio, sources, segments, want, tol, want_audio| Case {
            name,
            input: input.clone(),
            copy,
            audio,
            sources,
            segments,
            height: None,
            target_mb: None,
            rotate: 0,
            overlays: vec![],
            metadata: MetaEdit::default(),
            want_tags: vec![],
            want,
            tol,
            want_audio,
        };

        let cases = vec![
            case("copy-single", &clip, true, "separate", vec![src(0, 0.0)], vec![[10.0, 40.0]], 30.0, 0.1, 1),
            case("copy-multi", &clip, true, "separate", vec![src(0, 0.0)], vec![[0.0, 10.0], [21.0, 30.0], [60.0, 75.0]], 35.0, 2.2, 1),
            case("copy-gain", &clip, true, "mix", vec![src(0, -6.0)], vec![[3.0, 9.0], [50.0, 55.5]], 11.5, 2.2, 1),
            case("copy-beep", &clip, true, "mix", vec![src(0, 0.0), beep.clone()], vec![[0.0, 8.0], [12.0, 20.0]], 16.0, 0.1, 1),
            case("encode-multi", &clip, false, "mix", vec![src(0, 0.0)], vec![[5.5, 12.25], [40.0, 47.0]], 13.75, 0.1, 1),
            Case {
                height: Some(720),
                target_mb: Some(5.0),
                ..case("encode-target", &clip, false, "mix", vec![src(0, 0.0)], vec![[0.0, 60.0]], 60.0, 0.1, 1)
            },
            case("encode-none", &clip, false, "none", vec![src(0, 0.0)], vec![[30.0, 35.0]], 5.0, 0.1, 0),
            case("encode-beep", &clip, false, "mix", vec![beep.clone()], vec![[2.0, 9.0], [13.0, 14.0]], 8.0, 0.1, 1),
            Case { rotate: 90, ..case("encode-rotate", &clip, false, "mix", vec![src(0, 0.0)], vec![[0.0, 3.0]], 3.0, 0.1, 1) },
            Case {
                overlays: vec![logo.clone()],
                ..case("encode-overlay", &clip, false, "mix", vec![src(0, 0.0)], vec![[2.0, 6.0], [10.0, 14.0]], 8.0, 0.1, 1)
            },
            Case {
                metadata: edit.clone(),
                want_tags: edited.clone(),
                ..case("meta-copy", &tagged, true, "separate", vec![src(0, 0.0)], vec![[1.0, 5.0]], 4.0, 2.2, 1)
            },
            Case {
                metadata: edit.clone(),
                want_tags: edited.clone(),
                ..case("meta-encode", &tagged, false, "mix", vec![src(0, -2.0)], vec![[1.0, 5.0]], 4.0, 0.1, 1)
            },
            Case {
                metadata: MetaEdit { strip: true, tags: vec![] },
                want_tags: vec![("title", None), ("com.apple.quicktime.make", None)],
                ..case("meta-strip", &tagged, false, "mix", vec![src(0, 0.0)], vec![[1.0, 3.0]], 2.0, 0.1, 1)
            },
            // untouched tags survive an export, Apple-style ones included
            Case {
                want_tags: vec![("title", Some("Old")), ("com.apple.quicktime.model", Some("iPhone 16 Pro"))],
                ..case("meta-keep", &tagged, true, "separate", vec![src(0, 0.0)], vec![[0.0, 6.0]], 6.0, 0.2, 1)
            },
            case("mkv-copy-separate", &mkv, true, "separate", vec![src(0, 0.0), src(1, 0.0)], vec![[2.0, 8.0], [10.0, 20.0]], 16.0, 9.0, 2),
            case("mkv-copy-mix", &mkv, true, "mix", vec![src(0, 0.0), src(1, 2.0)], vec![[2.0, 8.0], [10.0, 20.0]], 16.0, 9.0, 1),
            case("mkv-copy-one-muted", &mkv, true, "separate", vec![src(1, 0.0)], vec![[0.0, 30.0]], 30.0, 0.2, 1),
            case(
                "mkv-encode-separate",
                &mkv,
                false,
                "separate",
                vec![src(0, 0.0), src(1, -3.0)],
                vec![[2.0, 8.0], [10.0, 20.0]],
                16.0,
                0.1,
                2,
            ),
        ];

        for c in cases {
            let output = path_str(&dir.join(format!("out-{}.mp4", c.name)));
            let job = ExportJob {
                input: c.input.clone(),
                output: output.clone(),
                segments: c.segments.clone(),
                copy: c.copy,
                encoder: enc.clone(),
                audio: c.audio.into(),
                sources: c.sources,
                height: c.height,
                target_mb: c.target_mb,
                rotate: c.rotate,
                flip: false,
                source_rotation: 0.0,
                overlays: c.overlays,
                metadata: c.metadata.clone(),
                meta: OnceLock::new(),
            };
            let started = std::time::Instant::now();
            run_export(app.handle(), &jobs, &job).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            let out = inspect(Path::new(&output));
            println!(
                "{}: {:.2}s long, {} audio, {}x{}, {:.1} MB, took {:.2}s",
                c.name,
                out.duration,
                out.audio,
                out.width,
                out.height,
                out.size as f64 / 1e6,
                started.elapsed().as_secs_f64()
            );
            // copy mode snaps starts back to keyframes, so it can only come out longer
            if c.copy {
                assert!(
                    out.duration >= c.want - 0.1 && out.duration <= c.want + c.tol,
                    "{}: duration {} vs {}",
                    c.name,
                    out.duration,
                    c.want
                );
            } else {
                assert!((out.duration - c.want).abs() <= c.tol, "{}: duration {} vs {}", c.name, out.duration, c.want);
            }
            assert_eq!(out.audio, c.want_audio, "{}: audio streams", c.name);
            if let Some(h) = c.height {
                assert_eq!(out.height, h as u64, "{}: height", c.name);
            }
            if c.rotate == 90 {
                assert!(out.height > out.width, "{}: should be portrait", c.name);
            }
            if let Some(mb) = c.target_mb {
                assert!(out.size as f64 <= mb * 1e6, "{}: {} bytes is over {mb} MB", c.name, out.size);
            }
            check_tags(c.name, &output, &c.want_tags);
        }

        // writing tags straight into a file swaps it in place
        let copy = dir.join("tagged-inplace.mp4");
        std::fs::copy(&tagged, &copy).unwrap();
        tauri::async_runtime::block_on(write_metadata(path_str(&copy), None, edit.clone())).unwrap();
        check_tags("write-in-place", &path_str(&copy), &edited);
        assert_eq!(inspect(&copy).audio, 1, "write-in-place: audio kept");
    }

    fn check_tags(name: &str, path: &str, want: &[(&str, Option<&str>)]) {
        let tags = read_tags_of(path);
        for (k, v) in want {
            assert_eq!(tags.get(*k).map(String::as_str), *v, "{name}: tag {k} (all: {tags:?})");
        }
    }
}
