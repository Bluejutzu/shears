use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
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
    cell.get_or_init(|| find_bin(name))
        .clone()
        .ok_or_else(|| format!("{name} wasn't found. Install it with: winget install Gyan.FFmpeg"))
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
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn secs(t: f64) -> String {
    format!("{t:.4}")
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
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    if let Ok(m) = std::fs::metadata(path) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    Ok(dir.join(format!("{:016x}{suffix}", h.finish())))
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
    blocking(|| {
        Ok(Tools {
            ffmpeg: bin("ffmpeg").ok().map(|p| path_str(&p)),
            encoder: detect_encoder(),
        })
    })
    .await
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
    size: u64,
    container: String,
}

fn ratio(s: &str) -> f64 {
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(0.0));
            if b > 0.0 { a / b } else { 0.0 }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

fn num<T: std::str::FromStr>(v: &Value) -> Option<T> {
    v.as_str().and_then(|s| s.parse().ok())
}

#[tauri::command]
pub async fn probe(path: String) -> Result<Probe, String> {
    blocking(move || {
        let out = command(&bin("ffprobe")?)
            .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(&path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(last_lines(&String::from_utf8_lossy(&out.stderr)));
        }
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let mut p = Probe {
            duration: num(&v["format"]["duration"]).unwrap_or(0.0),
            size: num(&v["format"]["size"]).unwrap_or(0),
            container: v["format"]["format_name"].as_str().unwrap_or("").into(),
            ..Default::default()
        };
        for s in v["streams"].as_array().into_iter().flatten() {
            match s["codec_type"].as_str() {
                Some("video")
                    if p.vcodec.is_empty() && s["disposition"]["attached_pic"].as_i64() != Some(1) =>
                {
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
                }
                Some("audio") => {
                    p.audio_tracks += 1;
                    if p.acodec.is_none() {
                        p.acodec = s["codec_name"].as_str().map(Into::into);
                    }
                }
                _ => {}
            }
        }
        if p.vcodec.is_empty() {
            return Err("No video stream in this file".into());
        }
        Ok(p)
    })
    .await
}

/// Audio peaks, 100 per second, 0-255.
#[tauri::command]
pub async fn waveform(path: String) -> Result<tauri::ipc::Response, String> {
    blocking(move || {
        let out = command(&bin("ffmpeg")?)
            .args(["-hide_banner", "-v", "error", "-i"])
            .arg(&path)
            .args(["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
            .stderr(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        let peaks: Vec<u8> = out
            .stdout
            .chunks(160)
            .map(|c| {
                let max = c
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs())
                    .max()
                    .unwrap_or(0);
                ((max as f32 / 32768.0).sqrt() * 255.0) as u8
            })
            .collect();
        Ok(tauri::ipc::Response::new(peaks))
    })
    .await
}

#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: String, at: f64) -> Result<String, String> {
    blocking(move || {
        let out = cache_file(&app, &path, ".jpg")?;
        if !out.exists() {
            let ok = command(&bin("ffmpeg")?)
                .args(["-hide_banner", "-v", "error", "-y", "-ss", &secs(at), "-i"])
                .arg(&path)
                .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4"])
                .arg(&out)
                .status()
                .is_ok_and(|s| s.success());
            if !ok {
                return Err("Couldn't grab a thumbnail".into());
            }
        }
        Ok(path_str(&out))
    })
    .await
}

#[tauri::command]
pub async fn save_frame(input: String, time: f64, output: String) -> Result<(), String> {
    blocking(move || {
        let out = command(&bin("ffmpeg")?)
            .args(["-hide_banner", "-v", "error", "-y", "-ss", &secs(time), "-i"])
            .arg(&input)
            .args(["-frames:v", "1"])
            .arg(&output)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(last_lines(&String::from_utf8_lossy(&out.stderr)))
        }
    })
    .await
}

/// Runs ffmpeg and reports progress as `base + done * weight` (0..1) on the "job-progress" event.
fn run<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, args: &[String], total: f64, base: f64, weight: f64) -> Result<(), String> {
    if jobs.cancelled.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    let mut child = command(&bin("ffmpeg")?)
        .args(["-hide_banner", "-v", "error", "-y", "-nostats", "-progress", "pipe:1"])
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

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
            let done = (us / 1e6 / total).clamp(0.0, 1.0);
            let _ = app.emit("job-progress", base + done * weight);
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
            a.extend(strs(&[
                "-b:v",
                &format!("{k}k"),
                "-maxrate",
                &format!("{k}k"),
                "-bufsize",
                &format!("{}k", k * 2.0),
            ]));
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    input: String,
    output: String,
    segments: Vec<[f64; 2]>,
    copy: bool,
    encoder: String,
    /// "keep" | "mute" | "merge"
    audio: String,
    audio_tracks: u32,
    height: Option<u32>,
    target_mb: Option<f64>,
}

impl ExportJob {
    fn total(&self) -> f64 {
        self.segments.iter().map(|s| s[1] - s[0]).sum::<f64>().max(0.01)
    }

    fn audio(&self) -> &str {
        match self.audio.as_str() {
            _ if self.audio_tracks == 0 => "mute",
            "merge" if self.audio_tracks < 2 => "keep",
            a => a,
        }
    }

    fn ext(&self) -> String {
        Path::new(&self.output)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "mp4".into())
    }

    fn faststart(&self, args: &mut Vec<String>) {
        if matches!(self.ext().as_str(), "mp4" | "mov" | "m4v") {
            args.extend(strs(&["-movflags", "+faststart"]));
        }
    }
}

fn amix(input: usize, tracks: u32, out: &str) -> String {
    let ins: String = (0..tracks).map(|t| format!("[{input}:a:{t}]")).collect();
    format!("{ins}amix=inputs={tracks}:normalize=0:duration=longest[{out}]")
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
        let jobs = app.state::<Jobs>();
        jobs.cancelled.store(false, Ordering::SeqCst);
        let result = if job.copy {
            export_copy(&app, &jobs, &job)
        } else {
            export_encode(&app, &jobs, &job)
        };
        if let Err(e) = result {
            let _ = std::fs::remove_file(&job.output);
            return Err(e);
        }
        Ok(std::fs::metadata(&job.output).map(|m| m.len()).unwrap_or(0))
    })
    .await
}

fn export_copy<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, job: &ExportJob) -> Result<(), String> {
    let total = job.total();
    let piece = |s: [f64; 2], out: String| {
        let mut a = strs(&["-ss", &secs(s[0]), "-t", &secs(s[1] - s[0]), "-i", &job.input]);
        a.extend(strs(&["-map", "0:v:0", "-c:v", "copy"]));
        match job.audio() {
            "mute" => a.push("-an".into()),
            "merge" => a.extend(strs(&[
                "-filter_complex",
                &amix(0, job.audio_tracks, "a"),
                "-map",
                "[a]",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ])),
            _ => a.extend(strs(&["-map", "0:a?", "-c:a", "copy"])),
        }
        a.extend(strs(&["-avoid_negative_ts", "make_zero"]));
        job.faststart(&mut a);
        a.push(out);
        a
    };

    if job.segments.len() == 1 {
        return run(app, jobs, &piece(job.segments[0], job.output.clone()), total, 0.0, 1.0);
    }

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("export-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let result = (|| {
        let ext = job.ext();
        let mut list = String::new();
        let mut done = 0.0;
        for (i, s) in job.segments.iter().enumerate() {
            let part = path_str(&dir.join(format!("part{i}.{ext}"))).replace('\\', "/");
            let len = s[1] - s[0];
            run(app, jobs, &piece(*s, part.clone()), len, done / total * 0.95, len / total * 0.95)?;
            done += len;
            list.push_str(&format!("file '{}'\n", part.replace('\'', "'\\''")));
        }
        let list_path = dir.join("list.txt");
        std::fs::write(&list_path, list).map_err(|e| e.to_string())?;
        let mut a = strs(&["-f", "concat", "-safe", "0", "-i", &path_str(&list_path)]);
        a.extend(strs(&["-map", "0", "-c", "copy"]));
        job.faststart(&mut a);
        a.push(job.output.clone());
        run(app, jobs, &a, total, 0.95, 0.05)
    })();

    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn export_encode<R: Runtime>(app: &AppHandle<R>, jobs: &Jobs, job: &ExportJob) -> Result<(), String> {
    let total = job.total();
    let audio = job.audio();
    let has_audio = audio != "mute";
    let scale = job
        .height
        .map(|h| format!("scale=-2:{h}:flags=lanczos,"))
        .unwrap_or_default();

    let mut args = Vec::new();
    let mut graph = String::new();
    let mut joined = String::new();
    // each kept part is its own seeked input, so ffmpeg never decodes the bits we threw away
    for (i, s) in job.segments.iter().enumerate() {
        args.extend(strs(&["-ss", &secs(s[0]), "-t", &secs(s[1] - s[0]), "-i", &job.input]));
        graph.push_str(&format!("[{i}:v:0]{scale}format=yuv420p,setsar=1[v{i}];"));
        joined.push_str(&format!("[v{i}]"));
        match audio {
            "mute" => {}
            "merge" => {
                graph.push_str(&amix(i, job.audio_tracks, &format!("a{i}")));
                graph.push(';');
                joined.push_str(&format!("[a{i}]"));
            }
            _ => {
                graph.push_str(&format!("[{i}:a:0]aresample=async=1[a{i}];"));
                joined.push_str(&format!("[a{i}]"));
            }
        }
    }
    graph.push_str(&format!(
        "{joined}concat=n={}:v=1:a={}[v]{}",
        job.segments.len(),
        has_audio as u8,
        if has_audio { "[a]" } else { "" }
    ));
    args.extend(strs(&["-filter_complex", &graph, "-map", "[v]"]));

    let audio_kbps = if job.target_mb.is_some() { 128.0 } else { 192.0 };
    if has_audio {
        args.extend(strs(&["-map", "[a]", "-c:a", "aac", "-b:a", &format!("{audio_kbps}k")]));
    }
    // leave a little headroom so we land under the size limit, not just over it
    let video_kbps = job.target_mb.map(|mb| {
        let audio = if has_audio { audio_kbps } else { 0.0 };
        (mb * 8000.0 * 0.94 / total - audio).max(150.0)
    });
    args.extend(encoder_args(&job.encoder, video_kbps));
    job.faststart(&mut args);
    args.push(job.output.clone());
    run(app, jobs, &args, total, 0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Out {
        duration: f64,
        audio: usize,
        height: u64,
        size: u64,
    }

    fn inspect(path: &Path) -> Out {
        let out = command(&bin("ffprobe").unwrap())
            .args(["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,height", "-of", "json"])
            .arg(path)
            .output()
            .unwrap();
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        let streams = v["streams"].as_array().unwrap();
        Out {
            duration: num(&v["format"]["duration"]).unwrap_or(0.0),
            size: num(&v["format"]["size"]).unwrap_or(0),
            audio: streams.iter().filter(|s| s["codec_type"] == "audio").count(),
            height: streams.iter().find_map(|s| s["height"].as_u64()).unwrap_or(0),
        }
    }

    // runs against real clips: set SHEARS_TEST_DIR to a folder with test-clip.mp4 (90s, 1 audio track)
    // and obs-style.mkv (30s, 2 audio tracks)
    #[test]
    fn exports() {
        let Some(dir) = std::env::var_os("SHEARS_TEST_DIR").map(PathBuf::from) else {
            return;
        };
        let app = tauri::test::mock_app();
        let jobs = Jobs::default();
        let clip = path_str(&dir.join("test-clip.mp4"));
        let mkv = path_str(&dir.join("obs-style.mkv"));
        let enc = detect_encoder();

        // (name, input, copy, audio, tracks, segments, height, target_mb, expected duration, tolerance, expected audio streams)
        let cases: Vec<(&str, &str, bool, &str, u32, Vec<[f64; 2]>, Option<u32>, Option<f64>, f64, f64, usize)> = vec![
            ("copy-single", &clip, true, "keep", 1, vec![[10.0, 40.0]], None, None, 30.0, 2.1, 1),
            ("copy-multi", &clip, true, "keep", 1, vec![[0.0, 10.0], [20.0, 30.0], [60.0, 75.0]], None, None, 35.0, 4.0, 1),
            ("encode-multi", &clip, false, "keep", 1, vec![[5.5, 12.25], [40.0, 47.0]], None, None, 13.75, 0.15, 1),
            ("encode-target", &clip, false, "keep", 1, vec![[0.0, 60.0]], Some(720), Some(5.0), 60.0, 0.15, 1),
            ("encode-mute", &clip, false, "mute", 1, vec![[30.0, 35.0]], None, None, 5.0, 0.15, 0),
            ("mkv-copy-keep", &mkv, true, "keep", 2, vec![[2.0, 8.0], [10.0, 20.0]], None, None, 16.0, 4.0, 2),
            ("mkv-copy-merge", &mkv, true, "merge", 2, vec![[2.0, 8.0], [10.0, 20.0]], None, None, 16.0, 4.0, 1),
            ("mkv-encode-merge", &mkv, false, "merge", 2, vec![[2.0, 8.0], [10.0, 20.0]], None, None, 16.0, 0.15, 1),
        ];

        for (name, input, copy, audio, tracks, segments, height, target_mb, want, tol, want_audio) in cases {
            let output = path_str(&dir.join(format!("out-{name}.mp4")));
            let job = ExportJob {
                input: input.into(),
                output: output.clone(),
                segments,
                copy,
                encoder: enc.clone(),
                audio: audio.into(),
                audio_tracks: tracks,
                height,
                target_mb,
            };
            let started = std::time::Instant::now();
            let result = if copy {
                export_copy(app.handle(), &jobs, &job)
            } else {
                export_encode(app.handle(), &jobs, &job)
            };
            result.unwrap_or_else(|e| panic!("{name}: {e}"));
            let out = inspect(Path::new(&output));
            println!(
                "{name}: {:.2}s long, {} audio, {}p, {:.1} MB, took {:.2}s",
                out.duration,
                out.audio,
                out.height,
                out.size as f64 / 1e6,
                started.elapsed().as_secs_f64()
            );
            assert!((out.duration - want).abs() <= tol, "{name}: duration {} vs {want}", out.duration);
            assert_eq!(out.audio, want_audio, "{name}: audio streams");
            if let Some(h) = height {
                assert_eq!(out.height, h as u64, "{name}: height");
            }
            if let Some(mb) = target_mb {
                assert!(out.size as f64 <= mb * 1e6, "{name}: {} bytes is over {mb} MB", out.size);
            }
        }
    }
}
