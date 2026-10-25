import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Camera,
  Clapperboard,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Crop,
  Download,
  Ellipsis,
  Expand,
  Film,
  FolderOpen,
  House,
  Keyboard,
  Minus,
  PanelLeft,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Square,
  StepBack,
  StepForward,
  Trash,
  TriangleAlert,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
  type IconNode,
} from "lucide";
import { api, encoderLabel, fileUrl, type Probe, type Tools } from "./api";
import { Edit } from "./edit";
import { openExport } from "./exporter";
import { Timeline } from "./timeline";
import {
  ago,
  basename,
  dirname,
  ext,
  fmt,
  fmtSize,
  h,
  icon,
  initTooltips,
  join,
  kbd,
  menu,
  menuOpen,
  modal,
  modalOpen,
  stem,
  toast,
} from "./ui";

const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "wmv", "mts", "m2ts", "3gp"];
const RATES = [0.25, 0.5, 1, 1.5, 2, 4];

const MarkIn: IconNode = [
  ["path", { d: "M10 4H6v16h4" }],
  ["path", { d: "M14 12h5" }],
];
const MarkOut: IconNode = [
  ["path", { d: "M14 4h4v16h-4" }],
  ["path", { d: "M5 12h5" }],
];

const appWindow = getCurrentWindow();
const $ = (id: string) => document.getElementById(id)!;
const mainEl = $("main");
const sidebarEl = $("sidebar");
const titleEl = $("title");
const tbActions = $("tb-actions");
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

let tools: Tools | null = null;

type Session = {
  path: string;
  probe: Probe;
  fps: number;
  edit: Edit;
  video: HTMLVideoElement;
  tl: Timeline;
  alive: boolean;
  previewStage: number;
  thumbsStarted: boolean;
  els: {
    cur: HTMLElement;
    play: HTMLElement;
    speed: HTMLElement;
    vol: HTMLElement;
    volRange: HTMLInputElement;
    out: HTMLElement;
    badge: HTMLElement;
    stageMsg: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    keep: HTMLButtonElement;
  };
};

let session: Session | null = null;
let openToken = 0;
let opening = false;

// ---- recents

type Recent = { path: string; at: number; duration: number; thumb?: string };

const recents = {
  list(): Recent[] {
    try {
      return JSON.parse(localStorage.getItem("recents") ?? "[]");
    } catch {
      return [];
    }
  },
  save(list: Recent[]) {
    localStorage.setItem("recents", JSON.stringify(list.slice(0, 20)));
    renderSidebar();
    if (!session && !opening) renderHome();
  },
  add(r: Recent) {
    recents.save([r, ...recents.list().filter((x) => x.path !== r.path)]);
  },
  update(path: string, patch: Partial<Recent>) {
    recents.save(recents.list().map((r) => (r.path === path ? { ...r, ...patch } : r)));
  },
  remove(path: string) {
    recents.save(recents.list().filter((r) => r.path !== path));
  },
};

// ---- little builders

function appMark(size: number) {
  const el = h("span", { class: "app-mark" });
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.6 14 17 5"/><path d="M13.4 14 7 5"/><circle cx="8.5" cy="17" r="2.7"/><circle cx="15.5" cy="17" r="2.7"/></svg>`;
  return el;
}

function iconBtn(ic: IconNode, tip: string, key: string | null, run: () => void, cls = "icon-btn") {
  return h("button", { class: cls, "data-tip": tip, "data-key": key, onclick: run }, icon(ic, 16)) as HTMLButtonElement;
}

function toolBtn(ic: IconNode, label: string, tip: string, key: string, run: () => void) {
  return h("button", { class: "tool", "data-tip": tip, "data-key": key, onclick: run }, icon(ic, 15), h("span", {}, label)) as HTMLButtonElement;
}

function toolsLabel() {
  if (!tools) return "Checking ffmpeg…";
  if (!tools.ffmpeg) return "ffmpeg not found";
  return `ffmpeg · ${encoderLabel(tools.encoder)}`;
}

function toolsChip() {
  const missing = tools && !tools.ffmpeg;
  return h(
    "span",
    {
      class: `chip${missing ? " warn" : ""}`,
      "data-tip": missing
        ? "Exporting needs ffmpeg. Install it with: winget install Gyan.FFmpeg"
        : tools
          ? `Re-encodes use ${encoderLabel(tools.encoder)}`
          : "Looking for ffmpeg",
    },
    missing ? icon(TriangleAlert, 14) : null,
    toolsLabel(),
  );
}

function setTitle(text: string) {
  titleEl.textContent = text;
  appWindow.setTitle(text === "Shears" ? "Shears" : `${text} — Shears`).catch(() => {});
}

// ---- sidebar

function renderSidebar() {
  const list = recents.list();
  const navItem = (ic: IconNode, label: string, run: () => void, cls = "") =>
    h("button", { class: `nav-item ${cls}`, onclick: run }, icon(ic, 18), h("span", {}, label));

  sidebarEl.replaceChildren(
    h(
      "nav",
      { class: "nav" },
      navItem(Plus, "Open video", openDialog, "primary"),
      navItem(House, "Home", () => closeSession(), !session ? "active" : ""),
      navItem(Keyboard, "Shortcuts", showShortcuts),
    ),
    h("div", { class: "sb-section" }, "Recents"),
    h(
      "div",
      { class: "recents" },
      ...(list.length ? list.map(recentItem) : [h("div", { class: "sb-empty" }, "Videos you open show up here")]),
    ),
    h(
      "div",
      { class: "sb-footer" },
      h("div", { class: "avatar" }, appMark(15)),
      h("div", { class: "sb-footer-text" }, h("div", {}, "Shears"), h("div", { class: "dim" }, toolsLabel())),
    ),
  );
}

function recentItem(r: Recent) {
  const more = h(
    "button",
    {
      class: "icon-btn sm more",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        menu(more, [
          { label: "Show in folder", icon: FolderOpen, run: () => api.reveal(r.path) },
          { label: "Remove from recents", icon: X, danger: true, run: () => recents.remove(r.path) },
        ]);
      },
    },
    icon(Ellipsis, 16),
  );
  return h(
    "div",
    {
      class: `recent-item${session?.path === r.path ? " active" : ""}`,
      role: "button",
      title: r.path,
      onclick: () => openFile(r.path),
    },
    h("span", { class: "recent-name" }, basename(r.path)),
    more,
  );
}

// ---- home

function renderHome() {
  setTitle("Shears");
  tbActions.replaceChildren();
  const list = recents.list();
  const card = (r: Recent) =>
    h(
      "button",
      { class: "card", onclick: () => openFile(r.path), title: r.path },
      h(
        "div",
        { class: "card-thumb" },
        r.thumb ? h("img", { src: fileUrl(r.thumb), alt: "", draggable: "false" }) : icon(Film, 26, 1.5),
        r.duration ? h("span", { class: "card-dur" }, fmt(r.duration, false)) : null,
      ),
      h("div", { class: "card-meta" }, h("div", { class: "card-title" }, basename(r.path)), h("div", { class: "card-sub" }, ago(r.at))),
    );

  mainEl.replaceChildren(
    h(
      "div",
      { class: "home" },
      h(
        "div",
        { class: "home-inner" },
        h(
          "div",
          { class: "dropzone", role: "button", onclick: (e: MouseEvent) => !(e.target as HTMLElement).closest("button, .chip") && openDialog() },
          h("div", { class: "dz-icon" }, icon(Upload, 22, 1.75)),
          h("h1", { class: "dz-title" }, "Drop a clip to start cutting"),
          h("div", { class: "dz-sub" }, "Trim, split and export without setting up a project."),
          h(
            "button",
            { class: "btn btn-primary dz-open", onclick: openDialog },
            icon(FolderOpen, 16),
            "Open video",
            h("kbd", { class: "kbd-on-primary" }, "Ctrl O"),
          ),
          h("div", { class: "dz-foot" }, h("span", {}, "MP4, MOV, MKV, WebM and more"), h("span", { class: "dot" }, "·"), toolsChip()),
        ),
        list.length
          ? h(
              "div",
              { class: "recent-head" },
              h("span", {}, "Recent clips"),
              h("button", { class: "link", onclick: () => recents.save([]) }, "Clear"),
            )
          : null,
        list.length ? h("div", { class: "recent-grid" }, ...list.slice(0, 6).map(card)) : null,
      ),
    ),
  );
}

// ---- opening files

async function openDialog() {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: VIDEO_EXTS }],
  });
  if (typeof picked === "string") openFile(picked);
}

function metaProbe(path: string): Promise<Probe | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () =>
      resolve({
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
        fps: 30,
        vcodec: "",
        acodec: null,
        audioTracks: 1,
        size: 0,
        container: "",
      });
    v.onerror = () => resolve(null);
    v.src = fileUrl(path);
  });
}

async function openFile(path: string) {
  if (session?.path === path) return;
  if (!VIDEO_EXTS.includes(ext(path))) {
    toast("That doesn't look like a video", { body: basename(path) });
    return;
  }
  const token = ++openToken;
  closeSession(false);
  setTitle(basename(path));
  mainEl.replaceChildren(h("div", { class: "loading" }, h("div", { class: "spinner" }), `Opening ${basename(path)}`));

  let probe: Probe | null;
  opening = true;
  try {
    probe = await api.probe(path);
  } catch (err) {
    probe = await metaProbe(path);
    if (!probe && token === openToken) {
      opening = false;
      toast("Couldn't open video", { body: String(err), error: true });
      renderHome();
      return;
    }
  }
  if (token !== openToken || !probe) return;
  opening = false;
  if (!(probe.duration > 0)) {
    toast("Couldn't open video", { body: "Couldn't read how long the video is.", error: true });
    renderHome();
    return;
  }

  buildEditor(path, probe);
  recents.add({ path, at: Date.now(), duration: probe.duration, thumb: recents.list().find((r) => r.path === path)?.thumb });
  if (tools?.ffmpeg !== null) {
    api
      .thumbnail(path, Math.min(probe.duration * 0.1, 5))
      .then((thumb) => recents.update(path, { thumb }))
      .catch(() => {});
  }
}

function closeSession(goHome = true) {
  const s = session;
  if (s) {
    s.alive = false;
    s.video.pause();
    s.video.removeAttribute("src");
    s.video.load();
    s.tl.destroy();
    session = null;
  }
  if (goHome) {
    renderHome();
    renderSidebar();
  }
}

// ---- editor

function buildEditor(path: string, probe: Probe) {
  const fps = probe.fps > 0 ? probe.fps : 30;
  const edit = new Edit(probe.duration, 1 / fps);
  const video = h("video", { class: "video", preload: "auto", playsinline: true }) as HTMLVideoElement;
  video.volume = clamp(parseFloat(localStorage.getItem("volume") ?? "1"), 0, 1);

  const stageMsg = h("div", { class: "stage-msg", hidden: true });
  const badge = h("div", { class: "stage-badge", hidden: true }, "Removed · won't be exported");
  const stage = h(
    "div",
    { class: "stage", onclick: (e: MouseEvent) => e.target === video && togglePlay() },
    video,
    badge,
    stageMsg,
  );

  const cur = h("span", { class: "time" }, fmt(0));
  const play = h("button", { class: "play-btn", "data-tip": "Play / pause", "data-key": "Space", onclick: togglePlay }, icon(Play, 18, 2));
  const speed = h("button", { class: "chip chip-btn", "data-tip": "Playback speed", onclick: () => speedMenu(speed) }, "1×");
  const vol = iconBtn(Volume2, "Mute", "M", toggleMute);
  const volRange = h("input", {
    class: "vol-range",
    type: "range",
    min: "0",
    max: "1",
    step: "0.01",
    value: String(video.volume),
    oninput: (e: Event) => {
      video.volume = parseFloat((e.target as HTMLInputElement).value);
      video.muted = false;
    },
    onchange: (e: Event) => (e.target as HTMLInputElement).blur(),
  }) as HTMLInputElement;

  const transport = h(
    "div",
    { class: "transport" },
    h("div", { class: "tp-side" }, cur, h("span", { class: "time dim" }, ` / ${fmt(probe.duration)}`)),
    h(
      "div",
      { class: "tp-center" },
      iconBtn(ChevronsLeft, "Previous cut", "↑", prevCut),
      iconBtn(StepBack, "Previous frame", "←", () => stepFrame(-1)),
      play,
      iconBtn(StepForward, "Next frame", "→", () => stepFrame(1)),
      iconBtn(ChevronsRight, "Next cut", "↓", nextCut),
    ),
    h("div", { class: "tp-side right" }, speed, vol, volRange),
  );

  const undo = iconBtn(Undo2, "Undo", "Ctrl Z", () => session?.edit.undo());
  const redo = iconBtn(Redo2, "Redo", "Ctrl Shift Z", () => session?.edit.redo());
  const keep = toolBtn(Crop, "Keep range", "Keep only the marked range", "T", keepRange);
  const toolbar = h(
    "div",
    { class: "toolbar" },
    h(
      "div",
      { class: "tool-group" },
      toolBtn(Scissors, "Split", "Split at playhead", "S", split),
      toolBtn(Trash, "Delete", "Remove or restore the selected part", "Del", del),
    ),
    h("div", { class: "tool-sep" }),
    h(
      "div",
      { class: "tool-group" },
      toolBtn(ArrowLeftToLine, "Trim start", "Remove from the start of this part up to the playhead", "Q", trimBefore),
      toolBtn(ArrowRightToLine, "Trim end", "Remove from the playhead to the end of this part", "W", trimAfter),
    ),
    h("div", { class: "tool-sep" }),
    h(
      "div",
      { class: "tool-group" },
      toolBtn(MarkIn, "In", "Mark in", "I", markIn),
      toolBtn(MarkOut, "Out", "Mark out", "O", markOut),
      keep,
    ),
    h("div", { class: "tool-sep" }),
    h("div", { class: "tool-group" }, undo, redo),
    h("div", { class: "spacer" }),
    h(
      "div",
      { class: "tool-group" },
      iconBtn(ZoomOut, "Zoom out", "-", () => session?.tl.zoomBy(1 / 1.5)),
      iconBtn(Expand, "Fit to window", "\\", () => session?.tl.fit()),
      iconBtn(ZoomIn, "Zoom in", "+", () => session?.tl.zoomBy(1.5)),
    ),
  );

  const tlHost = h("div", { class: "timeline-host" });
  const out = h("span", {});
  const info = [
    probe.width && `${probe.width}×${probe.height}`,
    probe.fps > 0 && `${+probe.fps.toFixed(2)} fps`,
    probe.vcodec && probe.vcodec.toUpperCase(),
    probe.acodec && (probe.audioTracks > 1 ? `${probe.audioTracks} audio tracks` : probe.acodec.toUpperCase()),
    probe.size && fmtSize(probe.size),
  ].filter(Boolean);

  mainEl.replaceChildren(
    h(
      "div",
      { class: "editor" },
      stage,
      transport,
      h("div", { class: "panel" }, toolbar, tlHost),
      h("div", { class: "statusbar" }, h("span", {}, info.join("  ·  ")), h("div", { class: "spacer" }), out),
    ),
  );

  const aspect = probe.width && probe.height ? probe.width / probe.height : 16 / 9;
  const tl = new Timeline(tlHost, edit, aspect, {
    time: () => video.currentTime,
    seek,
    select: (i) => {
      edit.sel = i;
      tl.invalidate();
    },
  });

  const s: Session = {
    path,
    probe,
    fps,
    edit,
    video,
    tl,
    alive: true,
    previewStage: 0,
    thumbsStarted: false,
    els: { cur, play, speed, vol, volRange, out, badge, stageMsg, undo, redo, keep },
  };
  session = s;
  edit.onChange = () => {
    tl.invalidate();
    updateUI(s);
  };

  video.addEventListener("loadedmetadata", () => {
    stageMsg.hidden = true;
    if (video.videoWidth && video.videoHeight) tl.aspect = video.videoWidth / video.videoHeight;
    if (!s.thumbsStarted) {
      s.thumbsStarted = true;
      genThumbs(s, video.currentSrc);
    }
  });
  video.addEventListener("error", () => previewFallback(s));
  video.addEventListener("play", () => play.replaceChildren(icon(Pause, 18, 2)));
  video.addEventListener("pause", () => play.replaceChildren(icon(Play, 18, 2)));
  video.addEventListener("ratechange", () => (speed.textContent = `${video.playbackRate}×`));
  video.addEventListener("volumechange", () => {
    vol.replaceChildren(icon(video.muted || video.volume === 0 ? VolumeX : Volume2, 16));
    volRange.value = String(video.muted ? 0 : video.volume);
    localStorage.setItem("volume", String(video.volume));
  });
  video.src = fileUrl(path);

  if (probe.audioTracks > 0 && tools?.ffmpeg !== null) {
    api
      .waveform(path)
      .then((peaks) => {
        if (s.alive) {
          tl.peaks = peaks;
          tl.invalidate();
        }
      })
      .catch(() => {});
  }

  setTitle(basename(path));
  tbActions.replaceChildren(
    iconBtn(Camera, "Save current frame as PNG", "Ctrl Shift S", saveFrame),
    iconBtn(X, "Close video", "Ctrl W", () => closeSession()),
    h("button", { class: "btn btn-primary btn-sm", "data-tip": "Export", "data-key": "Ctrl E", onclick: doExport }, icon(Download, 15), "Export"),
  );
  updateUI(s);
  renderSidebar();
}

function waitFor(el: HTMLMediaElement, event: string, timeout = 4000) {
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(false), timeout);
    el.addEventListener(event, onOk);
    el.addEventListener("error", onErr);
  });
}

/** Fill the filmstrip using a hidden second player, coarse first so the whole strip shows up quickly. */
async function genThumbs(s: Session, src: string) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = src;
  if (!(await waitFor(v, "loadeddata"))) return;
  const dur = s.probe.duration;
  const step = Math.max(0.5, dur / 150);
  const n = Math.max(1, Math.ceil(dur / step));
  s.tl.thumbStep = step;
  s.tl.thumbs = new Array(n);
  const H = Math.round(56 * devicePixelRatio);
  const W = Math.round(H * s.tl.aspect);
  const order: number[] = [];
  const seen = new Set<number>();
  for (const stride of [16, 4, 1]) {
    for (let i = 0; i < n; i += stride) {
      if (!seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    }
  }
  for (const i of order) {
    if (!s.alive) break;
    v.currentTime = Math.min(i * step + 0.05, Math.max(0, dur - 0.1));
    if (!(await waitFor(v, "seeked"))) continue;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d")!.drawImage(v, 0, 0, W, H);
    s.tl.thumbs[i] = c;
    s.tl.invalidate();
  }
  v.removeAttribute("src");
  v.load();
}

function showStageMsg(s: Session, title: string, body: string, progress = false) {
  const el = s.els.stageMsg;
  el.hidden = false;
  el.replaceChildren(
    h(
      "div",
      { class: "stage-card" },
      progress ? h("div", { class: "spinner" }) : icon(TriangleAlert, 22),
      h("div", { class: "stage-title" }, title),
      h("div", { class: "stage-body" }, body),
      progress ? h("div", { class: "progress" }, h("div", { class: "progress-fill" })) : null,
    ),
  );
}

async function previewFallback(s: Session) {
  if (!s.alive || !s.video.getAttribute("src")) return;
  if (s.previewStage >= 2 || !tools?.ffmpeg) {
    showStageMsg(s, "Can't preview this video", "The built-in player doesn't support its format, and ffmpeg isn't available to make a preview copy.");
    return;
  }
  s.previewStage++;
  const transcode = s.previewStage === 2;
  showStageMsg(
    s,
    transcode ? "Making a preview copy" : "Preparing preview",
    transcode
      ? "The player can't decode this codec, so Shears is making a light copy just for previewing. Exports still use the original."
      : "Repackaging the file so the player can read it. Exports still use the original.",
    true,
  );
  const unlisten = await listen<number>("job-progress", (e) => {
    const fill = s.els.stageMsg.querySelector<HTMLElement>(".progress-fill");
    if (fill) fill.style.width = `${e.payload * 100}%`;
  });
  try {
    const preview = await api.makePreview(s.path, s.probe.duration, transcode);
    if (s.alive) {
      s.thumbsStarted = false;
      s.video.src = fileUrl(preview);
    }
  } catch (err) {
    if (s.alive) showStageMsg(s, "Can't preview this video", String(err));
  } finally {
    unlisten();
  }
}

function updateUI(s: Session) {
  const e = s.edit;
  const kept = e.kept();
  const removed = s.probe.duration - e.outDuration();
  s.els.out.replaceChildren(
    h("span", { class: "dim" }, "Output "),
    h("span", {}, fmt(e.outDuration())),
    h("span", { class: "dim" }, `  ·  ${kept.length} ${kept.length === 1 ? "part" : "parts"}`),
    removed > 0.001 ? h("span", { class: "dim" }, `  ·  ${fmt(removed)} removed`) : "",
  );
  s.els.undo.disabled = !e.canUndo;
  s.els.redo.disabled = !e.canRedo;
  s.els.keep.disabled = !e.range();
}

// ---- actions

const time = () => session?.video.currentTime ?? 0;

function seek(t: number) {
  const s = session;
  if (!s) return;
  s.video.currentTime = clamp(t, 0, s.probe.duration);
  s.tl.invalidate();
}

function togglePlay() {
  const s = session;
  if (!s) return;
  const v = s.video;
  if (!v.paused) {
    v.pause();
    return;
  }
  const kept = s.edit.kept();
  if (!kept.length) return;
  const t = v.currentTime;
  if (t >= kept[kept.length - 1][1] - 0.05) v.currentTime = kept[0][0];
  else if (!s.edit.isKept(t)) v.currentTime = s.edit.nextKept(t) ?? kept[0][0];
  v.play().catch(() => {});
}

function stepFrame(n: number) {
  const s = session;
  if (!s) return;
  s.video.pause();
  seek(time() + n / s.fps);
}

const seekBy = (d: number) => seek(time() + d);

function cutPoints(s: Session) {
  const pts = [0, ...s.edit.cuts(), s.edit.inPt, s.edit.outPt, s.probe.duration];
  return pts.filter((p): p is number => p != null).sort((a, b) => a - b);
}

function prevCut() {
  if (!session) return;
  const t = time();
  const pts = cutPoints(session).filter((p) => p < t - 0.01);
  seek(pts.length ? pts[pts.length - 1] : 0);
}

function nextCut() {
  if (!session) return;
  const t = time();
  seek(cutPoints(session).find((p) => p > t + 0.01) ?? session.probe.duration);
}

function split() {
  session?.edit.split(time());
}

function del() {
  const e = session?.edit;
  if (!e) return;
  const r = e.range();
  if (r && e.sel < 0) e.setRange(r[0], r[1], false);
  else e.toggle(e.sel >= 0 ? e.sel : e.indexAt(time()));
}

const trimBefore = () => session?.edit.trimBefore(time());
const trimAfter = () => session?.edit.trimAfter(time());
const markIn = () => session?.edit.setMark("in", time());
const markOut = () => session?.edit.setMark("out", time());

function keepRange() {
  const e = session?.edit;
  if (!e) return;
  const r = e.range();
  if (!r) toast("No range marked", { body: "Press I and O to mark the part you want to keep." });
  else e.keepOnly(r[0], r[1]);
}

function deselect() {
  if (!session) return;
  session.edit.sel = -1;
  session.tl.invalidate();
}

function setRate(rate: number) {
  if (session) session.video.playbackRate = rate;
}

function shiftRate(dir: 1 | -1) {
  if (!session) return;
  const i = RATES.indexOf(session.video.playbackRate);
  setRate(RATES[clamp((i < 0 ? 2 : i) + dir, 0, RATES.length - 1)]);
}

function speedMenu(anchor: HTMLElement) {
  const current = session?.video.playbackRate ?? 1;
  menu(
    anchor,
    [{ section: "Playback speed" }, ...RATES.map((r, i) => ({ label: `${r}×`, hint: String(i + 1), checked: r === current, run: () => setRate(r) }))],
    { align: "end" },
  );
}

function toggleMute() {
  if (session) session.video.muted = !session.video.muted;
}

async function saveFrame() {
  const s = session;
  if (!s) return;
  if (!tools?.ffmpeg) {
    toast("ffmpeg not found", { body: "Saving frames needs ffmpeg. Install it with: winget install Gyan.FFmpeg", error: true });
    return;
  }
  const t = s.video.currentTime;
  const out = await api.uniquePath(join(dirname(s.path), `${stem(s.path)}_${fmt(t).replace(/[:.]/g, "-")}.png`));
  try {
    await api.saveFrame(s.path, t, out);
    toast("Frame saved", { body: basename(out), action: { label: "Show in folder", run: () => api.reveal(out) } });
  } catch (err) {
    toast("Couldn't save frame", { body: String(err), error: true });
  }
}

function doExport() {
  const s = session;
  if (!s) return;
  s.video.pause();
  openExport({ path: s.path, probe: s.probe, edit: s.edit, tools });
}

function toggleSidebar() {
  const collapsed = document.documentElement.classList.toggle("sb-collapsed");
  localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "");
}

// ---- keyboard

type Action = { label: string; keys: string[]; group: string; run: () => void; editor?: boolean };

const actions: Action[] = [
  { group: "Playback", label: "Play / pause", keys: ["space", "k"], run: togglePlay, editor: true },
  { group: "Playback", label: "Back / forward 5 seconds", keys: ["j", "l"], run: () => {}, editor: true },
  { group: "Playback", label: "Previous / next frame", keys: ["arrowleft", "arrowright"], run: () => {}, editor: true },
  { group: "Playback", label: "Back / forward 1 second", keys: ["shift+arrowleft", "shift+arrowright"], run: () => {}, editor: true },
  { group: "Playback", label: "Previous / next cut", keys: ["arrowup", "arrowdown"], run: () => {}, editor: true },
  { group: "Playback", label: "Go to start / end", keys: ["home", "end"], run: () => {}, editor: true },
  { group: "Playback", label: "Slower / faster", keys: ["<", ">"], run: () => {}, editor: true },
  { group: "Playback", label: "Mute", keys: ["m"], run: toggleMute, editor: true },
  { group: "Editing", label: "Split at playhead", keys: ["s", "ctrl+b"], run: split, editor: true },
  { group: "Editing", label: "Remove / restore part (or marked range)", keys: ["delete", "backspace"], run: del, editor: true },
  { group: "Editing", label: "Trim part start to playhead", keys: ["q"], run: trimBefore, editor: true },
  { group: "Editing", label: "Trim part end from playhead", keys: ["w"], run: trimAfter, editor: true },
  { group: "Editing", label: "Mark in / out", keys: ["i", "o"], run: () => {}, editor: true },
  { group: "Editing", label: "Keep only marked range", keys: ["t"], run: keepRange, editor: true },
  { group: "Editing", label: "Clear marks", keys: ["alt+x"], run: () => session?.edit.clearMarks(), editor: true },
  { group: "Editing", label: "Undo", keys: ["ctrl+z"], run: () => session?.edit.undo(), editor: true },
  { group: "Editing", label: "Redo", keys: ["ctrl+shift+z", "ctrl+y"], run: () => session?.edit.redo(), editor: true },
  { group: "Editing", label: "Deselect", keys: ["escape"], run: deselect, editor: true },
  { group: "Timeline", label: "Zoom in / out", keys: ["+", "-"], run: () => {}, editor: true },
  { group: "Timeline", label: "Fit timeline to window", keys: ["\\"], run: () => session?.tl.fit(), editor: true },
  { group: "General", label: "Open video", keys: ["ctrl+o"], run: openDialog },
  { group: "General", label: "Export", keys: ["ctrl+e"], run: doExport, editor: true },
  { group: "General", label: "Save current frame", keys: ["ctrl+shift+s"], run: saveFrame, editor: true },
  { group: "General", label: "Close video", keys: ["ctrl+w"], run: () => closeSession(), editor: true },
  { group: "General", label: "Toggle sidebar", keys: ["ctrl+."], run: toggleSidebar },
  { group: "General", label: "Keyboard shortcuts", keys: ["?"], run: showShortcuts },
];

// paired keys (j / l etc.) share one row in the shortcut list but each does its own thing
const keymap = new Map<string, Action>();
const pairs: Record<string, () => void> = {
  j: () => seekBy(-5),
  l: () => seekBy(5),
  arrowleft: () => stepFrame(-1),
  arrowright: () => stepFrame(1),
  "shift+arrowleft": () => seekBy(-1),
  "shift+arrowright": () => seekBy(1),
  arrowup: prevCut,
  arrowdown: nextCut,
  home: () => seek(0),
  end: () => seek(session?.probe.duration ?? 0),
  "<": () => shiftRate(-1),
  ">": () => shiftRate(1),
  i: markIn,
  o: markOut,
  "+": () => session?.tl.zoomBy(1.5),
  "=": () => session?.tl.zoomBy(1.5),
  "-": () => session?.tl.zoomBy(1 / 1.5),
};
for (const a of actions) for (const k of a.keys) keymap.set(k, pairs[k] ? { ...a, run: pairs[k] } : a);
keymap.set("=", { ...keymap.get("+")!, run: pairs["="] });

function comboOf(e: KeyboardEvent) {
  const key = e.key === " " ? "space" : e.key.toLowerCase();
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && !symbol) mods.push("shift");
  return [...mods, key].join("+");
}

const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  space: "Space",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  delete: "Del",
  backspace: "⌫",
  escape: "Esc",
  home: "Home",
  end: "End",
};
const keyLabel = (combo: string) =>
  combo
    .split(/\+(?!$)/)
    .map((k) => KEY_NAMES[k] ?? k.toUpperCase())
    .join(" ");

document.addEventListener("keydown", (e) => {
  if (modalOpen() || menuOpen()) return;
  const t = e.target as HTMLElement;
  if ((t instanceof HTMLInputElement && t.type !== "range") || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
  const a = keymap.get(comboOf(e));
  if (!a || (a.editor && !session)) return;
  e.preventDefault();
  a.run();
});

function showShortcuts() {
  const groups = ["Playback", "Editing", "Timeline", "General"];
  const body = h(
    "div",
    { class: "shortcuts" },
    h(
      "div",
      { class: "sc-grid" },
      ...groups.map((g) =>
        h(
          "div",
          { class: "sc-group" },
          h("div", { class: "sc-title" }, g),
          ...actions
            .filter((a) => a.group === g)
            .map((a) => h("div", { class: "sc-row" }, h("span", {}, a.label), h("span", { class: "sc-keys" }, ...a.keys.map((k) => kbd(keyLabel(k)))))),
        ),
      ),
    ),
    h(
      "div",
      { class: "sc-foot" },
      "Timeline: click to seek, drag a cut line to move it, scroll to zoom, Shift + scroll to pan. Scrubbing snaps to cuts; hold Shift to scrub freely.",
    ),
  );
  modal("Keyboard shortcuts", body, { wide: true });
}

// ---- render loop: skip removed parts during playback and keep the UI in sync

let lastClock = "";
function loop() {
  const s = session;
  if (s) {
    const v = s.video;
    const t = v.currentTime;
    if (!v.paused && !v.seeking && !s.edit.isKept(t)) {
      const next = s.edit.nextKept(t);
      if (next == null) {
        v.pause();
        const kept = s.edit.kept();
        if (kept.length) v.currentTime = kept[kept.length - 1][1];
      } else {
        v.currentTime = next;
      }
    }
    if (!v.paused) s.tl.follow(t);
    s.tl.render();
    const clock = fmt(t);
    if (clock !== lastClock) {
      s.els.cur.textContent = clock;
      lastClock = clock;
    }
    s.els.badge.hidden = !v.paused || s.edit.isKept(t);
  }
  requestAnimationFrame(loop);
}

// ---- window chrome + boot

function setupChrome() {
  $("btn-sidebar").append(icon(PanelLeft, 18));
  $("btn-sidebar").addEventListener("click", toggleSidebar);
  if (localStorage.getItem("sidebar-collapsed")) document.documentElement.classList.add("sb-collapsed");

  const min = $("win-min");
  const max = $("win-max");
  const close = $("win-close");
  min.append(icon(Minus, 16, 1.5));
  max.append(icon(Square, 13, 1.5));
  close.append(icon(X, 17, 1.5));
  min.addEventListener("click", () => appWindow.minimize());
  max.addEventListener("click", () => appWindow.toggleMaximize());
  close.addEventListener("click", () => appWindow.close());
  appWindow.onResized(async () => {
    const maximized = await appWindow.isMaximized();
    max.replaceChildren(maximized ? icon(Copy, 13, 1.5) : icon(Square, 13, 1.5));
  });

  // keep focus off buttons so Space/arrows always go to the editor
  document.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  if (!import.meta.env.DEV) document.addEventListener("contextmenu", (e) => e.preventDefault());

  document.body.append(
    h(
      "div",
      { class: "drop-overlay" },
      h(
        "div",
        { class: "drop-inner" },
        h("div", { class: "drop-icons" }, icon(Film, 30, 1.5), icon(Clapperboard, 30, 1.5), icon(FolderOpen, 30, 1.5)),
        h("div", { class: "drop-text" }, "Drop a video to open it"),
      ),
    ),
  );
  getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") document.body.classList.add("dragging");
    else if (p.type === "leave") document.body.classList.remove("dragging");
    else if (p.type === "drop") {
      document.body.classList.remove("dragging");
      const file = p.paths.find((x) => VIDEO_EXTS.includes(ext(x)));
      if (file) openFile(file);
      else if (p.paths.length) toast("That doesn't look like a video", { body: basename(p.paths[0]) });
    }
  });
}

initTooltips();
setupChrome();
renderSidebar();
renderHome();
requestAnimationFrame(loop);

api.tools().then((t) => {
  tools = t;
  renderSidebar();
  if (!session && !opening) renderHome();
});
api.initialFile().then((p) => {
  if (p) openFile(p);
});
