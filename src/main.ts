import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  BringToFront,
  Camera,
  ChevronsLeft,
  ChevronsRight,
  ChevronsRightLeft,
  Clapperboard,
  ClipboardPaste,
  Clock,
  Copy,
  CopyPlus,
  Crop,
  Crosshair,
  Download,
  Film,
  FileMusic,
  FoldHorizontal,
  FolderOpen,
  Headphones,
  House,
  ImagePlus,
  Info,
  Keyboard,
  Link2,
  ListRestart,
  Maximize,
  Minus,
  MoveHorizontal,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Plus,
  Redo2,
  Replace,
  RotateCw,
  Scan,
  Scissors,
  ScissorsLineDashed,
  SendToBack,
  Settings as SettingsIcon,
  Square,
  SquareDashedMousePointer,
  Tags,
  StepBack,
  StepForward,
  Trash,
  TriangleAlert,
  Undo2,
  Upload,
  Volume1,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
  type IconNode,
} from "lucide";

import {
  api,
  encoderLabel,
  fileUrl,
  type JobProgress,
  type MetaEdit,
  type Probe,
  type Tools,
} from "./api";
import { AudioEngine } from "./audio";
import { Edit, type Doc, type Look, type Overlay, type Track } from "./edit";
import { openExport } from "./exporter";
import { addMediaFolder, renderMediaPool, startMediaWatch } from "./media";
import { openMetadata } from "./metadata";
import {
  getImage,
  IMAGE_EXTS,
  imageSize,
  newOverlay,
  OverlayLayer,
} from "./overlays";
import {
  renderProps,
  setInspectorTab,
  showClipInfo,
  type InspectorTab,
} from "./props";
import {
  flushSettings,
  framePath,
  loadState,
  openSettings,
  saveSettings,
  setRecents,
  store,
  type Recent,
} from "./settings";
import { loadTheme, type Theme } from "./themes";
import { loadTimelineColors, Timeline, type Target } from "./timeline";
import {
  ago,
  basename,
  ext,
  fmt,
  fmtDb,
  fmtSize,
  h,
  icon,
  initTooltips,
  kbd,
  menu,
  menuOpen,
  modal,
  modalOpen,
  progressBar,
  stem,
  toast,
  type MenuItem,
} from "./ui";
import { autoCheck, checkForUpdates, setBeforeInstall } from "./updates";

const VIDEO_EXTS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "m4v",
  "avi",
  "flv",
  "ts",
  "wmv",
  "mts",
  "m2ts",
  "3gp",
];
const AUDIO_EXTS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "flac",
  "wma",
  ...VIDEO_EXTS,
];
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
let theme: Theme = { name: "shears", banner: () => {}, apply: () => {} };

type Session = {
  path: string;
  probe: Probe;
  fps: number;
  edit: Edit;
  video: HTMLVideoElement;
  tl: Timeline;
  layer: OverlayLayer;
  engine: AudioEngine;
  peaks: Map<string, Uint8Array>;
  loading: Set<string>;
  muted: boolean;
  alive: boolean;
  previewStage: number;
  thumbsStarted: boolean;
  els: {
    stage: HTMLElement;
    cur: HTMLElement;
    play: HTMLElement;
    speed: HTMLElement;
    vol: HTMLElement;
    volRange: HTMLInputElement;
    volLabel: HTMLElement;
    out: HTMLElement;
    badge: HTMLElement;
    stageMsg: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    keep: HTMLButtonElement;
    props: HTMLElement;
  };
};

let session: Session | null = null;
let openToken = 0;
let opening = false;

// ---- recents

const recents = {
  list: () => store.recents,
  save(list: Recent[]) {
    setRecents(list);
    renderSidebar();
    if (!session && !opening) renderHome();
  },
  add(r: Recent) {
    recents.save([r, ...store.recents.filter(x => x.path !== r.path)]);
  },
  update(path: string, patch: Partial<Recent>) {
    recents.save(
      store.recents.map(r => (r.path === path ? { ...r, ...patch } : r))
    );
  },
  remove(path: string) {
    recents.save(store.recents.filter(r => r.path !== path));
  },
};

// ---- little builders

function appMark(size: number) {
  const el = h("span", { class: "app-mark" });
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.6 14 17 5"/><path d="M13.4 14 7 5"/><circle cx="8.5" cy="17" r="2.7"/><circle cx="15.5" cy="17" r="2.7"/></svg>`;
  return el;
}

function iconBtn(
  ic: IconNode,
  tip: string,
  key: string | null,
  run: () => void,
  cls = "icon-btn"
) {
  return h(
    "button",
    { class: cls, "data-tip": tip, "data-key": key, onclick: run },
    icon(ic, 16)
  ) as HTMLButtonElement;
}

function toolBtn(
  ic: IconNode,
  label: string,
  tip: string,
  key: string,
  run: () => void
) {
  return h(
    "button",
    { class: "tool", "data-tip": tip, "data-key": key, onclick: run },
    icon(ic, 15),
    h("span", {}, label)
  ) as HTMLButtonElement;
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
    toolsLabel()
  );
}

/** The window title: the app's own name on the home screen, "clip.mp4 — Shears" while editing. */
function setTitle(text: string | null) {
  const app = store.app.name;
  titleEl.textContent = text ?? app;
  appWindow.setTitle(text ? ` — ` : app).catch(() => {});
}

// ---- sidebar: media pool

function renderSidebar() {
  const scroll = sidebarEl.querySelector(".media-scroll")?.scrollTop ?? 0;
  sidebarEl.replaceChildren(
    h(
      "nav",
      { class: "nav" },
      h(
        "button",
        { class: "nav-item primary", onclick: openDialog },
        icon(Plus, 18),
        h("span", {}, "Open video")
      )
    ),
    renderMediaPool({
      current: session?.path ?? null,
      open: openFile,
      removeRecent: p => recents.remove(p),
      addAudio: session ? p => addAudioTrack(undefined, p) : undefined,
    }),
    h(
      "div",
      { class: "sb-footer" },
      h(
        "div",
        { class: "sb-footer-id" },
        h("div", { class: "avatar" }, appMark(15)),
        h(
          "div",
          { class: "sb-footer-text" },
          h("div", {}, store.app.name),
          h("div", { class: "dim" }, toolsLabel())
        )
      ),
      h(
        "div",
        { class: "sb-footer-actions" },
        iconBtn(House, "Home", null, () => closeSession()),
        iconBtn(Keyboard, "Keyboard shortcuts", "?", showShortcuts),
        iconBtn(SettingsIcon, "Settings", "Ctrl ,", showSettings)
      )
    )
  );
  const scroller = sidebarEl.querySelector(".media-scroll");
  if (scroller) scroller.scrollTop = scroll;
}
function showSettings() {
  openSettings({
    onChange: () => {
      renderSidebar();
      if (!session) renderHome();
    },
    theme,
    restart: restartApp,
    colorsChanged: () => {
      loadTimelineColors();
      session?.tl.invalidate();
    },
    checkUpdates: () => checkForUpdates(),
  });
}

/** Reload the UI (used to switch themes), keeping settings, cuts and the open clip. */
async function restartApp() {
  if (session)
    try {
      sessionStorage.setItem("reopen", session.path);
    } catch {}
  await flushAll();
  location.reload();
}

// ---- home

function renderHome() {
  setTitle(null);
  tbActions.replaceChildren();
  const list = recents.list();
  const card = (r: Recent) =>
    h(
      "button",
      { class: "card", onclick: () => openFile(r.path), title: r.path },
      h(
        "div",
        { class: "card-thumb" },
        r.thumb
          ? h("img", {
              src: fileUrl(r.thumb),
              alt: "",
              draggable: "false",
              onerror: (e: Event) => (e.target as HTMLElement).remove(),
            })
          : icon(Film, 26, 1.5),
        r.duration
          ? h("span", { class: "card-dur" }, fmt(r.duration, false))
          : null
      ),
      h(
        "div",
        { class: "card-meta" },
        h("div", { class: "card-title" }, basename(r.path)),
        h("div", { class: "card-sub" }, ago(r.at))
      )
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
          {
            class: "dropzone",
            role: "button",
            onclick: (e: MouseEvent) =>
              !(e.target as HTMLElement).closest("button, .chip") &&
              openDialog(),
          },
          h("div", { class: "dz-icon" }, icon(Upload, 22, 1.75)),
          h("h1", { class: "dz-title" }, "Drop a clip to start cutting"),
          h(
            "div",
            { class: "dz-sub" },
            "Trim, split and export without setting up a project."
          ),
          h(
            "button",
            { class: "btn btn-primary dz-open", onclick: openDialog },
            icon(FolderOpen, 16),
            "Open video",
            h("kbd", { class: "kbd-on-primary" }, "Ctrl O")
          ),
          h(
            "div",
            { class: "dz-foot" },
            h("span", {}, "MP4, MOV, MKV, WebM and more"),
            h("span", { class: "dot" }, "·"),
            toolsChip()
          )
        ),
        list.length
          ? h(
              "div",
              { class: "recent-head" },
              h("span", {}, "Recent clips"),
              h(
                "button",
                { class: "link", onclick: () => recents.save([]) },
                "Clear"
              )
            )
          : null,
        list.length
          ? h("div", { class: "recent-grid" }, ...list.slice(0, 6).map(card))
          : null
      )
    )
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
  return new Promise(resolve => {
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
        audioTracks: 0,
        audio: [],
        rotation: 0,
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
  mainEl.replaceChildren(
    h(
      "div",
      { class: "loading" },
      h("div", { class: "spinner" }),
      `Opening ${basename(path)}`
    )
  );

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
  const saved = store.settings.rememberEdits
    ? await api.loadEdit(path).catch(() => null)
    : null;
  if (token !== openToken || !probe) return;
  opening = false;
  if (!(probe.duration > 0)) {
    toast("Couldn't open video", {
      body: "Couldn't read how long the video is.",
      error: true,
    });
    renderHome();
    return;
  }

  buildEditor(path, probe, saved as Doc | null);
  const known = store.recents.find(r => r.path === path)?.thumb;
  recents.add({ path, at: Date.now(), duration: probe.duration, thumb: known });
  if (known) theme.banner(fileUrl(known));
  if (tools?.ffmpeg !== null) {
    api
      .thumbnail(path, Math.min(probe.duration * 0.1, 5))
      .then(thumb => {
        recents.update(path, { thumb });
        if (session?.path === path) theme.banner(fileUrl(thumb));
      })
      .catch(() => {});
  }
}

function closeSession(goHome = true) {
  const s = session;
  if (s) {
    flushEditSave(s);
    s.alive = false;
    s.video.pause();
    s.video.removeAttribute("src");
    s.video.load();
    s.engine.destroy();
    s.tl.destroy();
    session = null;
    theme.banner(null);
  }
  if (goHome) {
    renderHome();
    renderSidebar();
  }
}

// ---- remembering cuts per clip

let saveTimer = 0;
let pendingSave: (() => Promise<void>) | null = null;

function scheduleEditSave(s: Session) {
  if (!store.settings.rememberEdits) return;
  clearTimeout(saveTimer);
  pendingSave = () => {
    pendingSave = null;
    return api
      .saveEdit(s.path, s.edit.pristine() ? null : s.edit.doc())
      .catch(() => {});
  };
  saveTimer = window.setTimeout(() => pendingSave?.(), 600);
}

function flushEditSave(_s: Session) {
  clearTimeout(saveTimer);
  return pendingSave?.() ?? Promise.resolve();
}

/** Write everything that's waiting to be saved: before closing, restarting or updating. */
async function flushAll() {
  if (session) await flushEditSave(session);
  await flushSettings().catch(() => {});
}

/** A remembered edit only fits if it was made for a file of the same length. */
function restorable(saved: Doc | null, probe: Probe): saved is Doc {
  if (!saved?.segs?.length || !Array.isArray(saved.tracks)) return false;
  const end = saved.segs[saved.segs.length - 1].end;
  return (
    Math.abs(end - probe.duration) < 0.05 &&
    saved.tracks.every(t => t.kind === "file" || t.index < probe.audio.length)
  );
}

// ---- editor

function sourceTracks(path: string, probe: Probe): Track[] {
  return probe.audio.map((a, i) => ({
    id: `a${i}`,
    kind: "source" as const,
    name: a.title || (probe.audio.length === 1 ? "Audio" : `Track ${i + 1}`),
    path,
    index: i,
    codec: a.codec,
    offset: 0,
    duration: probe.duration,
    gainDb: 0,
    muted: false,
    solo: false,
    linked: true,
  }));
}

/** Pull each track out so it can be played (and waveformed) on its own. */
function loadTrackMedia(s: Session, t: Track) {
  if (!tools?.ffmpeg || s.engine.has(t.id) || s.loading.has(t.id)) return;
  s.loading.add(t.id);
  api
    .extractAudio(t.path, t.index, t.codec)
    .then(file => {
      if (!s.alive || !s.edit.track(t.id)) return;
      s.engine.attach(t.id, fileUrl(file));
      s.engine.applyGains(s.edit.tracks);
    })
    .catch(err =>
      toast(`Couldn't load ${t.name}`, { body: String(err), error: true })
    )
    .finally(() => s.loading.delete(t.id));
  if (!s.peaks.has(t.id)) {
    api
      .waveform(t.path, t.index)
      .then(p => {
        if (!s.alive) return;
        s.peaks.set(t.id, p);
        s.tl.invalidate();
      })
      .catch(() => {});
  }
}

/** Add an audio file as a new track starting at t (the playhead by default). */
async function addAudioTrack(at?: number, file?: string) {
  const s = session;
  if (!s) return;
  if (!tools?.ffmpeg) {
    toast("ffmpeg not found", {
      body: "Adding audio tracks needs ffmpeg. Install it with: winget install Gyan.FFmpeg",
      error: true,
    });
    return;
  }
  const picked =
    file ??
    (await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
    }));
  if (typeof picked !== "string" || session !== s) return;
  try {
    const probe = await api.probeAudio(picked);
    const t: Track = {
      id: `f${Date.now().toString(36)}`,
      kind: "file",
      name: basename(picked).replace(/\.[^.]+$/, ""),
      path: picked,
      index: 0,
      codec: probe.audio[0].codec,
      offset: Math.round((at ?? s.video.currentTime) * 1000) / 1000,
      duration: probe.duration,
      gainDb: 0,
      muted: false,
      solo: false,
      linked: false,
    };
    s.edit.addTrack(t);
  } catch (err) {
    toast("Couldn't add that file", { body: String(err), error: true });
  }
}

/** Size of the frame as shown and exported: after the file's own rotation and ours. */
function frameSize(s: Session): [number, number] {
  const v = s.video;
  let w = v.videoWidth;
  let hgt = v.videoHeight;
  if (!w || !hgt) {
    w = s.probe.width || 16;
    hgt = s.probe.height || 9;
    if (Math.abs(Math.abs(s.probe.rotation % 180) - 90) < 1)
      [w, hgt] = [hgt, w];
  }
  const r = s.edit.look.rotate;
  return r === 90 || r === 270 ? [hgt, w] : [w, hgt];
}

/** Lay an image over the video from t (the playhead by default) for up to 5 seconds. */
async function addImage(at?: number, file?: string) {
  const s = session;
  if (!s) return;
  const picked =
    file ??
    (await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: IMAGE_EXTS }],
    }));
  if (typeof picked !== "string" || session !== s) return;
  try {
    const size = await imageSize(picked);
    if (session !== s) return;
    const dur = s.probe.duration;
    const start = clamp(at ?? s.video.currentTime, 0, Math.max(0, dur - 0.1));
    const [fw, fh] = frameSize(s);
    s.edit.addItems(
      [
        newOverlay(
          picked,
          stem(picked),
          Math.round(start * 1000) / 1000,
          Math.max(0.1, Math.min(5, dur - start)),
          size.w / size.h,
          fw / fh
        ),
      ],
      []
    );
  } catch {
    toast("Couldn't read that image", { body: basename(picked), error: true });
  }
}

function applyLook(s: Session) {
  const { rotate, flip } = s.edit.look;
  const v = s.video;
  const r = s.els.stage.getBoundingClientRect();
  let scale = 1;
  if (
    (rotate === 90 || rotate === 270) &&
    v.videoWidth &&
    v.videoHeight &&
    r.width
  ) {
    const fitted = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const turned = Math.min(r.width / v.videoHeight, r.height / v.videoWidth);
    scale = turned / fitted;
  }
  v.style.transform =
    rotate || flip
      ? `rotate(${rotate}deg) scale(${scale})${flip ? " scaleX(-1)" : ""}`
      : "";
  const st = s.els.stage;
  s.layer.place(st.clientWidth, st.clientHeight, ...frameSize(s));
}

// properties panel: re-render on change, but not while someone is dragging or typing in it
let propsFrame = 0;
let propsBusy = false;
window.addEventListener("pointerup", () => {
  if (!propsBusy) return;
  propsBusy = false;
  if (session) scheduleProps(session);
});
function scheduleProps(s: Session) {
  cancelAnimationFrame(propsFrame);
  propsFrame = requestAnimationFrame(() => {
    const el = s.els.props;
    const focused = document.activeElement;
    const typing =
      focused instanceof HTMLInputElement &&
      focused.type !== "range" &&
      el.contains(focused);
    if (propsBusy || typing || !store.settings.ui.propsOpen || !s.alive) return;
    renderProps(el, {
      path: s.path,
      probe: s.probe,
      edit: s.edit,
      addTrack: () => addAudioTrack(),
      addImage: () => addImage(),
      showInfo,
      showMetadata,
    });
  });
}

function splitter(
  kind: "h" | "v",
  onDrag: (delta: number, start: number) => void,
  onStart: () => number,
  onEnd: () => void,
  onReset: () => void
) {
  const el = h("div", {
    class: `split-${kind}`,
    "data-tip": "Drag to resize, double-click to reset",
  });
  el.addEventListener("pointerdown", e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const from = kind === "h" ? e.clientY : e.clientX;
    const start = onStart();
    el.classList.add("dragging");
    const move = (ev: PointerEvent) =>
      onDrag((kind === "h" ? ev.clientY : ev.clientX) - from, start);
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onEnd();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
  el.addEventListener("dblclick", onReset);
  return el;
}

function buildEditor(path: string, probe: Probe, saved: Doc | null) {
  const fps = probe.fps > 0 ? probe.fps : 30;
  const edit = new Edit(probe.duration, 1 / fps);
  edit.tracks = sourceTracks(path, probe);
  const restored = restorable(saved, probe);
  if (restored)
    edit.load({
      ...saved,
      tracks: saved.tracks.map(t => ({
        ...t,
        linked: t.linked ?? t.kind === "source",
      })),
    });
  edit.selectLane("video", true);

  const layer = new OverlayLayer(edit, id => {
    edit.selected = [id];
    edit.onChange();
  });
  const video = h("video", {
    class: "video",
    preload: "auto",
    playsinline: true,
  }) as HTMLVideoElement;
  const stageMsg = h("div", { class: "stage-msg", hidden: true });
  const badge = h(
    "div",
    { class: "stage-badge", hidden: true },
    "Removed · won't be exported"
  );
  const stage = h(
    "div",
    {
      class: "stage",
      onclick: (e: MouseEvent) => e.target === video && togglePlay(),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        const item = (e.target as HTMLElement).closest<HTMLElement>(".ov-item");
        const id = item?.dataset.id;
        if (id) {
          if (!edit.isSelected(id)) {
            edit.selected = [id];
            edit.onChange();
          }
          timelineMenu(
            {
              t: video.currentTime,
              area: "image",
              id,
              onClip: true,
              header: true,
            },
            e
          );
        } else stageMenu(e);
      },
    },
    video,
    layer.el,
    badge,
    stageMsg
  );

  const cur = h("span", { class: "time" }, fmt(0));
  const play = h(
    "button",
    {
      class: "play-btn",
      "data-tip": "Play / pause",
      "data-key": "Space",
      onclick: togglePlay,
    },
    icon(Play, 18, 2)
  );
  const speed = h(
    "button",
    {
      class: "chip chip-btn",
      "data-tip": "Playback speed",
      onclick: () => speedMenu(speed),
    },
    "1×"
  );
  const vol = iconBtn(Volume2, "Mute", "M", toggleMute);
  const volLabel = h(
    "span",
    { class: "vol-label" },
    fmtDb(store.settings.volumeDb)
  );
  const volRange = h("input", {
    class: "vol-range",
    type: "range",
    min: "-40",
    max: "12",
    step: "0.5",
    value: String(store.settings.volumeDb),
    "data-tip": "Preview volume · scroll to adjust, double-click for 0 dB",
    oninput: (e: Event) => setVolume(+(e.target as HTMLInputElement).value),
    onchange: (e: Event) => (e.target as HTMLInputElement).blur(),
    ondblclick: () => setVolume(0),
    onwheel: (e: WheelEvent) => {
      e.preventDefault();
      setVolume(store.settings.volumeDb + (e.deltaY < 0 ? 1 : -1));
    },
  }) as HTMLInputElement;

  const transport = h(
    "div",
    { class: "transport" },
    h(
      "div",
      { class: "tp-side" },
      cur,
      h("span", { class: "time dim" }, ` / ${fmt(probe.duration)}`)
    ),
    h(
      "div",
      { class: "tp-center" },
      iconBtn(ChevronsLeft, "Previous cut", "↑", prevCut),
      iconBtn(StepBack, "Previous frame", "←", () => stepFrame(-1)),
      play,
      iconBtn(StepForward, "Next frame", "→", () => stepFrame(1)),
      iconBtn(ChevronsRight, "Next cut", "↓", nextCut)
    ),
    h("div", { class: "tp-side right" }, speed, vol, volRange, volLabel)
  );

  const undo = iconBtn(Undo2, "Undo", "Ctrl Z", () => session?.edit.undo());
  const redo = iconBtn(Redo2, "Redo", "Ctrl Shift Z", () =>
    session?.edit.redo()
  );
  const keep = toolBtn(
    Crop,
    "Keep range",
    "Keep only the marked range",
    "T",
    keepRange
  );
  const linkToggle = iconBtn(
    Link2,
    "Linked selection: clicking the video or a linked track selects them together",
    "Ctrl Shift L",
    toggleLinkedSelection
  );
  linkToggle.classList.add("toggle-btn");
  linkToggle.classList.toggle("on", store.settings.ui.linkedSelection);
  linkToggle.id = "link-toggle";
  const collapseToggle = iconBtn(
    ChevronsRightLeft,
    "Collapse removed parts so the kept ones fill the timeline",
    "H",
    toggleCollapseRemoved
  );
  collapseToggle.classList.add("toggle-btn");
  collapseToggle.classList.toggle("on", store.settings.ui.collapseRemoved);
  collapseToggle.id = "collapse-toggle";
  const toolbar = h(
    "div",
    { class: "toolbar" },
    h(
      "div",
      { class: "tool-group" },
      toolBtn(Scissors, "Split", "Split at playhead", "S", split),
      toolBtn(
        Trash,
        "Delete",
        "Remove or restore the selected part",
        "Del",
        del
      )
    ),
    h("div", { class: "tool-sep" }),
    h(
      "div",
      { class: "tool-group" },
      toolBtn(
        ArrowLeftToLine,
        "Trim start",
        "Remove from the start of this part up to the playhead",
        "Q",
        trimBefore
      ),
      toolBtn(
        ArrowRightToLine,
        "Trim end",
        "Remove from the playhead to the end of this part",
        "W",
        trimAfter
      )
    ),
    h("div", { class: "tool-sep" }),
    h(
      "div",
      { class: "tool-group" },
      toolBtn(MarkIn, "In", "Mark in", "I", markIn),
      toolBtn(MarkOut, "Out", "Mark out", "O", markOut),
      keep
    ),
    h("div", { class: "tool-sep" }),
    h("div", { class: "tool-group" }, undo, redo),
    h("div", { class: "tool-sep" }),
    linkToggle,
    collapseToggle,
    h("div", { class: "spacer" }),
    h(
      "div",
      { class: "tool-group" },
      iconBtn(ZoomOut, "Zoom out", "-", () => session?.tl.zoomBy(1 / 1.5)),
      iconBtn(FoldHorizontal, "Fit whole clip in the timeline", "\\", () =>
        session?.tl.fit()
      ),
      iconBtn(ZoomIn, "Zoom in", "+", () => session?.tl.zoomBy(1.5))
    )
  );

  const tlHost = h("div", { class: "timeline-host" });
  const out = h("span", {});
  const info = [
    probe.width && `${probe.width}×${probe.height}`,
    probe.fps > 0 && `${+probe.fps.toFixed(2)} fps`,
    probe.vcodec && probe.vcodec.toUpperCase(),
    probe.size && fmtSize(probe.size),
  ].filter(Boolean);

  const ui = store.settings.ui;
  const editorCol = h("div", { class: "editor" });
  const applyStageHeight = () => {
    stage.style.flex = ui.stageHeight ? `0 0 ${ui.stageHeight}px` : "";
    editorCol.classList.toggle("fixed-stage", !!ui.stageHeight);
  };
  const stageSplit = splitter(
    "h",
    (d, start) => {
      ui.stageHeight = clamp(start + d, 140, editorCol.clientHeight - 200);
      applyStageHeight();
    },
    () => stage.getBoundingClientRect().height,
    saveSettings,
    () => {
      ui.stageHeight = null;
      applyStageHeight();
      saveSettings();
    }
  );
  editorCol.append(
    stage,
    stageSplit,
    transport,
    h("div", { class: "panel" }, toolbar, tlHost),
    h(
      "div",
      { class: "statusbar" },
      h("span", {}, info.join("  ·  ")),
      h("div", { class: "spacer" }),
      out
    )
  );
  applyStageHeight();

  const props = h("aside", {
    class: "props",
    style: `width:${ui.propsWidth}px`,
  });
  props.addEventListener("pointerdown", e => {
    if ((e.target as HTMLElement).closest(".props-title"))
      startDock(e, workspace, editorCol, props);
    else propsBusy = true;
  });
  props.addEventListener(
    "focusout",
    () => session && setTimeout(() => session && scheduleProps(session), 0)
  );
  const propsSplit = splitter(
    "v",
    (d, start) => {
      ui.propsWidth = clamp(
        start + (ui.propsSide === "left" ? d : -d),
        240,
        520
      );
      props.style.width = `${ui.propsWidth}px`;
    },
    () => props.getBoundingClientRect().width,
    saveSettings,
    () => {
      ui.propsWidth = 300;
      props.style.width = "300px";
      saveSettings();
    }
  );
  const workspace = h(
    "div",
    {
      class: `workspace${ui.propsOpen ? "" : " props-hidden"}${ui.propsSide === "left" ? " props-left" : ""}`,
    },
    editorCol,
    propsSplit,
    props
  );
  mainEl.replaceChildren(workspace);

  const aspect =
    probe.width && probe.height ? probe.width / probe.height : 16 / 9;
  const peaks = new Map<string, Uint8Array>();
  const tl = new Timeline(tlHost, edit, aspect, {
    time: () => video.currentTime,
    seek,
    peaks: id => peaks.get(id) ?? null,
    image: path => getImage(path, () => tl.invalidate()),
    addTrack: () => addAudioTrack(),
    changed: () => edit.onChange(),
    linkedSelection: () => store.settings.ui.linkedSelection,
    collapseRemoved: () => store.settings.ui.collapseRemoved,
    menu: timelineMenu,
  });

  const engine = new AudioEngine(video);
  const s: Session = {
    path,
    probe,
    fps,
    edit,
    video,
    tl,
    layer,
    engine,
    peaks,
    loading: new Set(),
    muted: false,
    alive: true,
    previewStage: 0,
    thumbsStarted: false,
    els: {
      stage,
      cur,
      play,
      speed,
      vol,
      volRange,
      volLabel,
      out,
      badge,
      stageMsg,
      undo,
      redo,
      keep,
      props,
    },
  };
  session = s;
  engine.setMaster(store.settings.volumeDb, false);

  edit.onChange = () => {
    tl.refresh();
    updateUI(s);
    engine.prune(new Set(edit.tracks.map(t => t.id)));
    for (const t of edit.tracks) loadTrackMedia(s, t);
    engine.applyGains(edit.tracks);
    applyLook(s);
    layer.update(video.currentTime);
    scheduleProps(s);
    scheduleEditSave(s);
  };

  new ResizeObserver(() => applyLook(s)).observe(stage);
  video.addEventListener("loadedmetadata", () => {
    stageMsg.hidden = true;
    if (video.videoWidth && video.videoHeight)
      tl.aspect = video.videoWidth / video.videoHeight;
    applyLook(s);
    if (!s.thumbsStarted) {
      s.thumbsStarted = true;
      genThumbs(s, video.currentSrc);
    }
  });
  video.addEventListener("error", () => previewFallback(s));
  video.addEventListener("play", () => {
    engine.resume();
    play.replaceChildren(icon(Pause, 18, 2));
  });
  video.addEventListener("pause", () =>
    play.replaceChildren(icon(Play, 18, 2))
  );
  video.addEventListener(
    "ratechange",
    () => (speed.textContent = `${video.playbackRate}×`)
  );
  video.src = fileUrl(path);

  setTitle(basename(path));
  tbActions.replaceChildren(
    iconBtn(Info, "Clip info", "Ctrl I", showInfo),
    iconBtn(Camera, "Save current frame as PNG", "Ctrl Shift S", saveFrame),
    iconBtn(PanelRight, "Properties panel", "Ctrl P", toggleProps),
    iconBtn(X, "Close video", "Ctrl W", () => closeSession()),
    h(
      "button",
      {
        class: "btn btn-primary btn-sm",
        "data-tip": "Export",
        "data-key": "Ctrl E",
        onclick: doExport,
      },
      icon(Download, 15),
      "Export"
    )
  );
  edit.onChange();
  updateVolumeUI(s);
  renderSidebar();

  if (restored) {
    toast("Picked up where you left off", {
      body: "Your cuts and track settings for this clip were restored.",
      action: {
        label: "Start fresh instead",
        run: () => {
          if (session !== s) return;
          edit.checkpoint();
          edit.load({
            segs: [{ start: 0, end: probe.duration, on: true }],
            inPt: null,
            outPt: null,
            tracks: sourceTracks(path, probe),
            look: { rotate: 0, flip: false },
            overlays: [],
          });
          edit.onChange();
        },
      },
    });
  }
}

function waitFor(el: HTMLMediaElement, event: string, timeout = 4000) {
  return new Promise<boolean>(resolve => {
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

let stageProgress = (_p: number) => {};

function showStageMsg(
  s: Session,
  title: string,
  body: string,
  progress = false
) {
  const el = s.els.stageMsg;
  el.hidden = false;
  const bar = progressBar();
  stageProgress = bar.set;
  el.replaceChildren(
    h(
      "div",
      { class: "stage-card" },
      progress ? h("div", { class: "spinner" }) : icon(TriangleAlert, 22),
      h("div", { class: "stage-title" }, title),
      h("div", { class: "stage-body" }, body),
      progress ? bar.el : null
    )
  );
}

async function previewFallback(s: Session) {
  if (!s.alive || !s.video.getAttribute("src")) return;
  if (s.previewStage >= 2 || !tools?.ffmpeg) {
    showStageMsg(
      s,
      "Can't preview this video",
      "The built-in player doesn't support its format, and ffmpeg isn't available to make a preview copy."
    );
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
    true
  );
  const unlisten = await listen<JobProgress>("job-progress", e => {
    stageProgress(e.payload.p);
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
    h(
      "span",
      { class: "dim" },
      `  ·  ${kept.length} ${kept.length === 1 ? "part" : "parts"}`
    ),
    removed > 0.001
      ? h("span", { class: "dim" }, `  ·  ${fmt(removed)} removed`)
      : ""
  );
  s.els.undo.disabled = !e.canUndo;
  s.els.redo.disabled = !e.canRedo;
  s.els.keep.disabled = !e.range();
}

function updateVolumeUI(s: Session) {
  const db = store.settings.volumeDb;
  const off = s.muted || db <= -40;
  s.els.vol.replaceChildren(
    icon(off ? VolumeX : db < -12 ? Volume1 : Volume2, 16)
  );
  s.els.volRange.value = String(db);
  s.els.volLabel.textContent = db <= -40 ? "Off" : fmtDb(db);
  s.els.volLabel.classList.toggle("dim", off);
}

function setVolume(db: number) {
  const s = session;
  db = Math.round(clamp(db, -40, 12) * 2) / 2;
  store.settings.volumeDb = db;
  saveSettings();
  if (!s) return;
  s.engine.setMaster(db, s.muted);
  updateVolumeUI(s);
}

function toggleProps() {
  const ui = store.settings.ui;
  ui.propsOpen = !ui.propsOpen;
  saveSettings();
  document
    .querySelector(".workspace")
    ?.classList.toggle("props-hidden", !ui.propsOpen);
  if (session) scheduleProps(session);
}

function showInfo() {
  if (session)
    showClipInfo(
      session.path,
      session.probe,
      session.edit.tracks,
      showMetadata
    );
}

function showMetadata() {
  const s = session;
  if (!s) return;
  s.video.pause();
  openMetadata({
    path: s.path,
    edit: s.edit,
    write: (m, out) => writeMetadata(s, m, out),
  });
}

/** Write tags into the clip's file. The preview lets go of the file while it gets swapped. */
async function writeMetadata(s: Session, m: MetaEdit, output: string | null) {
  const v = s.video;
  const t = v.currentTime;
  v.pause();
  v.removeAttribute("src");
  v.load();
  try {
    await api.writeMetadata(s.path, output, m);
    toast("Metadata written", { body: basename(output ?? s.path) });
    return true;
  } catch (err) {
    toast("Couldn't write metadata", { body: String(err), error: true });
    return false;
  } finally {
    if (session === s) {
      // the file's bytes moved around, so make sure the player doesn't reuse what it cached
      v.src = `${fileUrl(s.path)}?v=${Date.now()}`;
      v.addEventListener("loadedmetadata", () => (v.currentTime = t), {
        once: true,
      });
    }
  }
}

function toggleCollapseRemoved() {
  const ui = store.settings.ui;
  ui.collapseRemoved = !ui.collapseRemoved;
  saveSettings();
  document
    .getElementById("collapse-toggle")
    ?.classList.toggle("on", ui.collapseRemoved);
  session?.tl.fit();
}

function toggleLinkedSelection() {
  const ui = store.settings.ui;
  ui.linkedSelection = !ui.linkedSelection;
  saveSettings();
  document
    .getElementById("link-toggle")
    ?.classList.toggle("on", ui.linkedSelection);
  toast(ui.linkedSelection ? "Linked selection on" : "Linked selection off", {
    body: ui.linkedSelection
      ? "Clicking the video or a linked track selects them together."
      : "Clicking a lane selects just that lane.",
  });
}

/** Drag the inspector by its title and drop it on the left or right of the editor. */
function startDock(
  e: PointerEvent,
  workspace: HTMLElement,
  editorCol: HTMLElement,
  props: HTMLElement
) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLElement | null = null;
  let marker: HTMLElement | null = null;
  let side = store.settings.ui.propsSide;

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      ghost = h("div", { class: "dock-ghost" }, "Inspector");
      marker = h("div", { class: "dock-marker" });
      document.body.append(ghost);
      workspace.append(marker);
      props.classList.add("lifting");
    }
    const r = workspace.getBoundingClientRect();
    side = ev.clientX < r.left + r.width / 2 ? "left" : "right";
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    marker!.className = `dock-marker show ${side}`;
    marker!.style.width = `${props.offsetWidth}px`;
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!ghost) return;
    ghost.classList.add("leaving");
    setTimeout(() => ghost?.remove(), 160);
    marker?.remove();
    props.classList.remove("lifting");
    if (side === store.settings.ui.propsSide) return;

    // swap sides, then slide both panes from their old spots into the new ones
    const before = [editorCol, props].map(
      el => el.getBoundingClientRect().left
    );
    store.settings.ui.propsSide = side;
    saveSettings();
    workspace.classList.toggle("props-left", side === "left");
    [editorCol, props].forEach((el, i) => {
      const dx = before[i] - el.getBoundingClientRect().left;
      el.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
        { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    });
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
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
  s.engine.resume();
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
  const pts = [
    0,
    ...s.edit.cuts(),
    s.edit.inPt,
    s.edit.outPt,
    s.probe.duration,
  ];
  return pts.filter((p): p is number => p != null).sort((a, b) => a - b);
}

function prevCut() {
  if (!session) return;
  const t = time();
  const pts = cutPoints(session).filter(p => p < t - 0.01);
  seek(pts.length ? pts[pts.length - 1] : 0);
}

function nextCut() {
  if (!session) return;
  const t = time();
  seek(cutPoints(session).find(p => p > t + 0.01) ?? session.probe.duration);
}

function split() {
  session?.edit.split(time());
}

function del() {
  const e = session?.edit;
  if (!e) return;
  // a selected image or added audio file (without the video) gets deleted like a clip
  if (!e.isSelected("video") && removableIds().length) {
    deleteSelection();
    return;
  }
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
  if (!r)
    toast("No range marked", {
      body: "Press I and O to mark the part you want to keep.",
    });
  else e.keepOnly(r[0], r[1]);
}

// ---- clipboard: images and audio tracks can be cut, copied, pasted and duplicated

let clipboard: { overlays: Overlay[]; tracks: Track[]; anchor: number } | null =
  null;

const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * What cut/copy/duplicate/delete act on: the given ids (a right-clicked track or image),
 * otherwise the selection. From the selection, the video's own tracks only count when
 * picked on their own, not as part of the linked video.
 */
function selectedItems(ids?: string[]) {
  const e = session?.edit;
  if (!e) return { overlays: [], tracks: [] };
  const pick = (id: string) => (ids ? ids.includes(id) : e.isSelected(id));
  return {
    overlays: e.overlays.filter(o => pick(o.id)),
    tracks: e.tracks.filter(
      t => pick(t.id) && (!!ids || t.kind === "file" || !e.isSelected("video"))
    ),
  };
}

/** The ones that can be deleted outright (the video's own tracks can't). */
function removableIds(ids?: string[]) {
  const { overlays, tracks } = selectedItems(ids);
  return [...overlays, ...tracks.filter(t => t.kind === "file")].map(x => x.id);
}

const startOf = (x: Overlay | Track) =>
  "start" in x ? x.start : x.kind === "file" ? x.offset : 0;

function copySelection(cut = false, ids?: string[]) {
  const s = session;
  if (!s) return;
  const { overlays, tracks } = selectedItems(ids);
  if (!overlays.length && !tracks.length) {
    // nothing to copy, so copy where the playhead is instead
    copyTimecode(s.video.currentTime);
    return;
  }
  clipboard = {
    overlays: overlays.map(o => ({ ...o })),
    tracks: tracks.map(t => ({ ...t })),
    anchor: Math.min(...[...overlays, ...tracks].map(startOf)),
  };
  if (cut) s.edit.removeItems(removableIds(ids));
}

/** Copies of overlays starting at `start`, kept inside the clip. */
function placeOverlay(o: Overlay, start: number, dur: number): Overlay {
  const at = ms(clamp(start, 0, dur - 0.1));
  return {
    ...o,
    id: newId("o"),
    start: at,
    duration: ms(Math.min(o.duration, dur - at)),
  };
}

/** A track of the video itself comes back as its own track, playing the same audio. */
const copyTrack = (t: Track, offset: number): Track => ({
  ...t,
  id: newId("f"),
  kind: "file",
  offset: ms(offset),
  linked: false,
  solo: false,
});

/** Paste so the earliest copied item starts at `at` (the playhead by default). */
function paste(at?: number) {
  const s = session;
  if (!s || !clipboard) return;
  const shift = (at ?? s.video.currentTime) - clipboard.anchor;
  const dur = s.probe.duration;
  s.edit.addItems(
    clipboard.overlays.map(o => placeOverlay(o, o.start + shift, dur)),
    clipboard.tracks.map(t => copyTrack(t, startOf(t) + shift))
  );
}

/** Copies right next to the originals: images after themselves, tracks on a new lane. */
function duplicate(ids?: string[]) {
  const s = session;
  if (!s) return;
  const { overlays, tracks } = selectedItems(ids);
  if (!overlays.length && !tracks.length) return;
  const dur = s.probe.duration;
  s.edit.addItems(
    overlays.map(o => placeOverlay(o, o.start + o.duration, dur)),
    tracks.map(t => copyTrack(t, startOf(t)))
  );
}

function deleteSelection(ids?: string[]) {
  const del = removableIds(ids);
  if (del.length) session?.edit.removeItems(del);
}

function copyTimecode(t: number) {
  const tc = fmt(t);
  navigator.clipboard?.writeText(tc).catch(() => {});
  toast(`Copied timecode ${tc}`);
}

async function replaceImage(o: Overlay) {
  const s = session;
  const picked = await open({
    multiple: false,
    directory: false,
    defaultPath: o.path,
    filters: [{ name: "Images", extensions: IMAGE_EXTS }],
  });
  if (typeof picked !== "string" || session !== s) return;
  s?.edit.updateOverlay(o.id, { path: picked, name: stem(picked) });
}

// ---- right-click menus: a few common actions up top, the rest grouped in submenus

const hint = (combo: string) => keyLabel(combo);
const ms = (t: number) => Math.round(t * 1000) / 1000;

function openInspector(tab: InspectorTab) {
  setInspectorTab(tab);
  if (!store.settings.ui.propsOpen) toggleProps();
  else if (session) scheduleProps(session);
}

/** Cut / copy / paste / duplicate / delete for `ids` (or the selection), greyed out when they don't apply. */
function editMenu(at: number, ids?: string[]): MenuItem {
  const { overlays, tracks } = selectedItems(ids);
  const any = overlays.length + tracks.length > 0;
  const removable = removableIds(ids).length > 0;
  return {
    label: "Edit",
    icon: Copy,
    items: [
      {
        label: "Cut",
        icon: ScissorsLineDashed,
        hint: hint("ctrl+x"),
        disabled: !removable,
        run: () => copySelection(true, ids),
      },
      {
        label: "Copy",
        icon: Copy,
        hint: hint("ctrl+c"),
        disabled: !any,
        run: () => copySelection(false, ids),
      },
      pasteItem(at),
      {
        label: "Duplicate",
        icon: CopyPlus,
        hint: hint("ctrl+d"),
        disabled: !any,
        run: () => duplicate(ids),
      },
    ],
  };
}

const pasteItem = (at: number): MenuItem => ({
  label: "Paste here",
  icon: ClipboardPaste,
  hint: hint("ctrl+v"),
  disabled: !clipboard,
  run: () => paste(at),
});

const splitItem = (t: number): MenuItem => ({
  label: "Split here",
  icon: Scissors,
  hint: hint("s"),
  run: () => session?.edit.split(t),
});

function partMenu(t: number): MenuItem {
  const e = session!.edit;
  const i = e.indexAt(t);
  const seg = e.segs[i];
  return {
    label: "Part",
    icon: Crop,
    items: [
      seg.on &&
        e.segs.length > 1 && {
          label: "Keep only this part",
          icon: Crop,
          run: () => e.keepOnly(seg.start, seg.end),
        },
      seg.on && {
        label: "Trim start to here",
        icon: ArrowLeftToLine,
        hint: hint("q"),
        run: () => e.trimBefore(t),
      },
      seg.on && {
        label: "Trim end from here",
        icon: ArrowRightToLine,
        hint: hint("w"),
        run: () => e.trimAfter(t),
      },
      e.segs.some(s => !s.on) && {
        label: "Restore all removed parts",
        icon: ListRestart,
        run: () => e.setRange(0, e.duration, true),
      },
    ],
  };
}

const removeItem = (t: number): MenuItem => {
  const e = session!.edit;
  const i = e.indexAt(t);
  const on = e.segs[i].on;
  return {
    label: on ? "Remove this part" : "Restore this part",
    icon: on ? Trash : Undo2,
    hint: hint("delete"),
    run: () => e.toggle(i),
  };
};

function marksMenu(t: number): MenuItem {
  const e = session!.edit;
  return {
    label: "Marks",
    icon: MarkIn,
    items: [
      {
        label: "Mark in here",
        icon: MarkIn,
        hint: hint("i"),
        run: () => e.setMark("in", t),
      },
      {
        label: "Mark out here",
        icon: MarkOut,
        hint: hint("o"),
        run: () => e.setMark("out", t),
      },
      !!e.range() && "sep",
      !!e.range() && {
        label: "Keep only marked range",
        icon: Crop,
        hint: hint("t"),
        run: keepRange,
      },
      !!e.range() && {
        label: "Clear marks",
        icon: X,
        hint: hint("alt+x"),
        run: () => e.clearMarks(),
      },
    ],
  };
}

const addMenu = (t: number): MenuItem => ({
  label: "Add",
  icon: Plus,
  items: [
    {
      label: "Image here…",
      icon: ImagePlus,
      hint: hint("ctrl+shift+i"),
      run: () => addImage(t),
    },
    {
      label: "Audio here…",
      icon: FileMusic,
      hint: hint("ctrl+shift+a"),
      run: () => addAudioTrack(t),
    },
    "sep",
    pasteItem(t),
  ],
});

function viewMenu(): MenuItem {
  const ui = store.settings.ui;
  return {
    label: "View",
    icon: FoldHorizontal,
    items: [
      {
        label: "Fit whole clip",
        icon: FoldHorizontal,
        hint: hint("\\"),
        run: () => session?.tl.fit(),
      },
      {
        label: "Zoom in",
        icon: ZoomIn,
        hint: hint("+"),
        run: () => session?.tl.zoomBy(1.5),
      },
      {
        label: "Zoom out",
        icon: ZoomOut,
        hint: hint("-"),
        run: () => session?.tl.zoomBy(1 / 1.5),
      },
      "sep",
      {
        label: "Collapse removed parts",
        icon: ChevronsRightLeft,
        hint: hint("h"),
        checked: ui.collapseRemoved,
        run: toggleCollapseRemoved,
      },
      {
        label: "Linked selection",
        icon: Link2,
        hint: hint("ctrl+shift+l"),
        checked: ui.linkedSelection,
        run: toggleLinkedSelection,
      },
    ],
  };
}

/** Frame, rotation and file info: things about the whole clip. */
function clipMenu(t: number): MenuItem {
  const e = session!.edit;
  return {
    label: "Clip",
    icon: Film,
    items: [
      {
        label: "Save frame as PNG",
        icon: Camera,
        hint: hint("ctrl+shift+s"),
        run: () => {
          seek(t);
          saveFrame();
        },
      },
      { label: "Copy timecode", icon: Clock, run: () => copyTimecode(t) },
      "sep",
      {
        label: "Rotate",
        icon: RotateCw,
        items: ([0, 90, 180, 270] as Look["rotate"][]).map(r => ({
          label: `${r}°`,
          checked: e.look.rotate === r,
          run: () => e.setLook({ rotate: r }),
        })),
      },
      {
        label: "Flip horizontally",
        icon: MoveHorizontal,
        checked: e.look.flip,
        run: () => e.setLook({ flip: !e.look.flip }),
      },
      "sep",
      { label: "Clip info", icon: Info, hint: hint("ctrl+i"), run: showInfo },
      {
        label: "Edit metadata…",
        icon: Tags,
        hint: hint("ctrl+shift+m"),
        run: showMetadata,
      },
    ],
  };
}

const inspectorItem = (tab: InspectorTab): MenuItem => ({
  label: "Show in Inspector",
  icon: PanelRight,
  run: () => openInspector(tab),
});

function videoItems(t: number, header: boolean): MenuItem[] {
  const s = session!;
  const e = s.edit;
  const i = e.indexAt(t);
  const seg = e.segs[i];
  return [
    {
      section: header
        ? "V1 · Video · at the playhead"
        : `Part ${i + 1} of ${e.segs.length} · ${fmt(seg.start, false)}–${fmt(seg.end, false)}${seg.on ? "" : " · removed"}`,
    },
    {
      label: "Play from here",
      icon: Play,
      run: () => {
        seek(seg.on ? t : (e.nextKept(t) ?? t));
        if (s.video.paused) togglePlay();
      },
    },
    splitItem(t),
    removeItem(t),
    partMenu(t),
    marksMenu(t),
    "sep",
    addMenu(t),
    clipMenu(t),
    "sep",
    inspectorItem("video"),
  ];
}

function trackItems(
  t: Track,
  at: number,
  onClip: boolean,
  header: boolean
): MenuItem[] {
  const e = session!.edit;
  const i = e.tracks.indexOf(t);
  const gain = (db: number) =>
    e.updateTrack(t.id, { gainDb: Math.round(clamp(db, -30, 12) * 10) / 10 });
  return [
    { section: `A${i + 1} · ${t.name}` },
    {
      label: "Mute",
      icon: VolumeX,
      checked: t.muted,
      run: () => e.updateTrack(t.id, { muted: !t.muted }),
    },
    {
      label: "Solo",
      icon: Headphones,
      checked: t.solo,
      run: () => e.updateTrack(t.id, { solo: !t.solo }),
    },
    {
      label: "Volume",
      icon: Volume2,
      hint: fmtDb(t.gainDb),
      items: [
        {
          label: "Reset to 0 dB",
          disabled: t.gainDb === 0,
          run: () => gain(0),
        },
        { label: "Louder · +3 dB", run: () => gain(t.gainDb + 3) },
        { label: "Quieter · −3 dB", run: () => gain(t.gainDb - 3) },
        { label: "Much quieter · −10 dB", run: () => gain(t.gainDb - 10) },
      ],
    },
    "sep",
    editMenu(at, [t.id]),
    {
      label: "Track",
      icon: FileMusic,
      items: [
        {
          label: "Linked to the video",
          icon: Link2,
          checked: t.linked,
          run: () => e.updateTrack(t.id, { linked: !t.linked }),
        },
        t.kind === "file" && {
          label: onClip || header ? "Start at playhead" : "Move start here",
          icon: ArrowLeftToLine,
          run: () =>
            e.updateTrack(t.id, { offset: ms(onClip || header ? time() : at) }),
        },
        "sep",
        {
          label: "Move up",
          icon: ArrowUp,
          disabled: i === 0,
          run: () => e.moveTrack(i, i - 1),
        },
        {
          label: "Move down",
          icon: ArrowDown,
          disabled: i === e.tracks.length - 1,
          run: () => e.moveTrack(i, i + 1),
        },
        t.kind === "file" && "sep",
        t.kind === "file" && {
          label: "Show file in folder",
          icon: FolderOpen,
          run: () => api.reveal(t.path),
        },
      ],
    },
    // cuts go through every track, so splitting from here works too
    !header && splitItem(at),
    t.kind === "file" && {
      label: "Delete track",
      icon: Trash,
      danger: true,
      run: () => deleteSelection([t.id]),
    },
    "sep",
    inspectorItem("audio"),
  ];
}

function imageItems(o: Overlay, at: number, onClip: boolean): MenuItem[] {
  const s = session!;
  const e = s.edit;
  const i = e.overlays.indexOf(o);
  const now = time();
  const [fw, fh] = frameSize(s);
  const img = getImage(o.path);
  // image aspect over frame aspect: 1 means the image has the frame's shape
  const fit = img.naturalWidth
    ? img.naturalWidth / img.naturalHeight / (fw / fh)
    : 1;
  const set = (patch: Partial<Overlay>) => e.updateOverlay(o.id, patch);
  return [
    { section: `V${i + 2} · ${o.name}` },
    editMenu(at, [o.id]),
    {
      label: "Timing",
      icon: Clock,
      items: [
        {
          label: onClip ? "Start at playhead" : "Move here",
          icon: ArrowLeftToLine,
          run: () => set({ start: ms(onClip ? now : at) }),
        },
        {
          label: "End at playhead",
          icon: ArrowRightToLine,
          disabled: now <= o.start + 0.05,
          run: () => set({ duration: ms(now - o.start) }),
        },
        {
          label: "Show for the whole clip",
          icon: MoveHorizontal,
          run: () => set({ start: 0, duration: s.probe.duration }),
        },
      ],
    },
    {
      label: "Size & position",
      icon: Scan,
      items: [
        {
          label: "Center",
          icon: Crosshair,
          run: () => set({ x: 0.5, y: 0.5 }),
        },
        {
          label: "Fit to frame",
          icon: Scan,
          run: () => set({ x: 0.5, y: 0.5, scale: ms(Math.min(1, fit)) }),
        },
        {
          label: "Fill frame",
          icon: Maximize,
          run: () => set({ x: 0.5, y: 0.5, scale: ms(Math.max(1, fit)) }),
        },
        "sep",
        {
          label: "Opacity",
          hint: `${Math.round(o.opacity * 100)}%`,
          items: [1, 0.75, 0.5, 0.25].map(v => ({
            label: `${v * 100}%`,
            checked: Math.abs(o.opacity - v) < 0.005,
            run: () => set({ opacity: v }),
          })),
        },
      ],
    },
    {
      label: "Arrange",
      icon: BringToFront,
      items: [
        {
          label: "Bring forward",
          icon: BringToFront,
          disabled: i === e.overlays.length - 1,
          run: () => e.restackOverlay(o.id, 1),
        },
        {
          label: "Send backward",
          icon: SendToBack,
          disabled: i === 0,
          run: () => e.restackOverlay(o.id, -1),
        },
      ],
    },
    {
      label: "File",
      icon: FolderOpen,
      items: [
        { label: "Replace image…", icon: Replace, run: () => replaceImage(o) },
        {
          label: "Show in folder",
          icon: FolderOpen,
          run: () => api.reveal(o.path),
        },
      ],
    },
    {
      label: "Delete image",
      icon: Trash,
      hint: hint("delete"),
      danger: true,
      run: () => deleteSelection([o.id]),
    },
    "sep",
    inspectorItem("image"),
  ];
}

function timelineMenu(target: Target, ev: MouseEvent) {
  const s = session;
  if (!s) return;
  const e = s.edit;
  const t = target.t;
  const track = target.id ? e.track(target.id) : undefined;
  const overlay = target.id ? e.overlay(target.id) : undefined;
  let items: MenuItem[];
  if (overlay) items = imageItems(overlay, t, !!target.onClip);
  else if (track)
    items = trackItems(track, t, !!target.onClip, !!target.header);
  else if (target.area === "video") items = videoItems(t, !!target.header);
  else if (target.area === "ruler")
    items = [
      { label: "Go here", icon: Play, run: () => seek(t) },
      splitItem(t),
      marksMenu(t),
      "sep",
      viewMenu(),
    ];
  else
    items = [
      {
        label: "Add image here…",
        icon: ImagePlus,
        hint: hint("ctrl+shift+i"),
        run: () => addImage(t),
      },
      {
        label: "Add audio here…",
        icon: FileMusic,
        hint: hint("ctrl+shift+a"),
        run: () => addAudioTrack(t),
      },
      pasteItem(t),
      "sep",
      splitItem(t),
      marksMenu(t),
      "sep",
      {
        label: "Undo",
        icon: Undo2,
        hint: hint("ctrl+z"),
        disabled: !e.canUndo,
        run: () => e.undo(),
      },
      {
        label: "Redo",
        icon: Redo2,
        hint: hint("ctrl+shift+z"),
        disabled: !e.canRedo,
        run: () => e.redo(),
      },
      {
        label: "Select all",
        icon: SquareDashedMousePointer,
        hint: hint("ctrl+a"),
        run: selectAll,
      },
      "sep",
      viewMenu(),
    ];
  menu({ x: ev.clientX, y: ev.clientY }, items);
}

/** Right-click on the preview (not on an image). */
function stageMenu(ev: MouseEvent) {
  const s = session;
  if (!s) return;
  const t = s.video.currentTime;
  menu({ x: ev.clientX, y: ev.clientY }, [
    {
      label: s.video.paused ? "Play" : "Pause",
      icon: s.video.paused ? Play : Pause,
      hint: hint("space"),
      run: togglePlay,
    },
    {
      label: "Add image…",
      icon: ImagePlus,
      hint: hint("ctrl+shift+i"),
      run: () => addImage(t),
    },
    {
      label: "Paste",
      icon: ClipboardPaste,
      hint: hint("ctrl+v"),
      disabled: !clipboard,
      run: () => paste(t),
    },
    "sep",
    clipMenu(t),
  ]);
}

function selectAll() {
  const e = session?.edit;
  if (!e) return;
  e.selected = [
    "video",
    ...e.tracks.map(t => t.id),
    ...e.overlays.map(o => o.id),
  ];
  e.onChange();
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
    [
      { section: "Playback speed" },
      ...RATES.map((r, i) => ({
        label: `${r}×`,
        hint: String(i + 1),
        checked: r === current,
        run: () => setRate(r),
      })),
    ],
    { align: "end" }
  );
}

function toggleMute() {
  const s = session;
  if (!s) return;
  s.muted = !s.muted;
  s.engine.setMaster(store.settings.volumeDb, s.muted);
  s.engine.applyGains(s.edit.tracks);
  updateVolumeUI(s);
}

async function saveFrame() {
  const s = session;
  if (!s) return;
  if (!tools?.ffmpeg) {
    toast("ffmpeg not found", {
      body: "Saving frames needs ffmpeg. Install it with: winget install Gyan.FFmpeg",
      error: true,
    });
    return;
  }
  const t = s.video.currentTime;
  const out = await api.uniquePath(
    framePath(s.path, fmt(t).replace(/[:.]/g, "-"))
  );
  try {
    await api.saveFrame(s.path, t, out, s.edit.look.rotate, s.edit.look.flip);
    toast("Frame saved", {
      body: basename(out),
      action: { label: "Show in folder", run: () => api.reveal(out) },
    });
  } catch (err) {
    toast("Couldn't save frame", { body: String(err), error: true });
  }
}

function doExport() {
  const s = session;
  if (!s) return;
  s.video.pause();
  openExport({
    path: s.path,
    probe: s.probe,
    edit: s.edit,
    tools,
    thumbAt: t => s.tl.thumbAt(t),
  });
}

function toggleSidebar() {
  const ui = store.settings.ui;
  ui.sidebarCollapsed = !ui.sidebarCollapsed;
  document.documentElement.classList.toggle(
    "sb-collapsed",
    ui.sidebarCollapsed
  );
  saveSettings();
}

// ---- keyboard

type Action = {
  label: string;
  keys: string[];
  group: string;
  run: () => void;
  editor?: boolean;
};

const actions: Action[] = [
  {
    group: "Playback",
    label: "Play / pause",
    keys: ["space", "k"],
    run: togglePlay,
    editor: true,
  },
  {
    group: "Playback",
    label: "Back / forward 5 seconds",
    keys: ["j", "l"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Previous / next frame",
    keys: ["arrowleft", "arrowright"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Back / forward 1 second",
    keys: ["shift+arrowleft", "shift+arrowright"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Previous / next cut",
    keys: ["arrowup", "arrowdown"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Go to start / end",
    keys: ["home", "end"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Slower / faster",
    keys: ["<", ">"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Mute preview",
    keys: ["m"],
    run: toggleMute,
    editor: true,
  },
  {
    group: "Editing",
    label: "Split at playhead",
    keys: ["s", "ctrl+b"],
    run: split,
    editor: true,
  },
  {
    group: "Editing",
    label: "Remove / restore part (or marked range)",
    keys: ["delete", "backspace"],
    run: del,
    editor: true,
  },
  {
    group: "Editing",
    label: "Trim part start to playhead",
    keys: ["q"],
    run: trimBefore,
    editor: true,
  },
  {
    group: "Editing",
    label: "Trim part end from playhead",
    keys: ["w"],
    run: trimAfter,
    editor: true,
  },
  {
    group: "Editing",
    label: "Mark in / out",
    keys: ["i", "o"],
    run: () => {},
    editor: true,
  },
  {
    group: "Editing",
    label: "Keep only marked range",
    keys: ["t"],
    run: keepRange,
    editor: true,
  },
  {
    group: "Editing",
    label: "Clear marks",
    keys: ["alt+x"],
    run: () => session?.edit.clearMarks(),
    editor: true,
  },
  {
    group: "Editing",
    label: "Cut / copy / paste image or audio",
    keys: ["ctrl+x", "ctrl+c", "ctrl+v"],
    run: () => {},
    editor: true,
  },
  {
    group: "Editing",
    label: "Duplicate",
    keys: ["ctrl+d"],
    run: duplicate,
    editor: true,
  },
  {
    group: "Editing",
    label: "Select all",
    keys: ["ctrl+a"],
    run: selectAll,
    editor: true,
  },
  {
    group: "Editing",
    label: "Undo",
    keys: ["ctrl+z"],
    run: () => session?.edit.undo(),
    editor: true,
  },
  {
    group: "Editing",
    label: "Redo",
    keys: ["ctrl+shift+z", "ctrl+y"],
    run: () => session?.edit.redo(),
    editor: true,
  },
  {
    group: "Editing",
    label: "Deselect",
    keys: ["escape"],
    run: deselect,
    editor: true,
  },
  {
    group: "Timeline",
    label: "Zoom in / out",
    keys: ["+", "-"],
    run: () => {},
    editor: true,
  },
  {
    group: "Timeline",
    label: "Fit whole clip",
    keys: ["\\"],
    run: () => session?.tl.fit(),
    editor: true,
  },
  {
    group: "Timeline",
    label: "Add audio track",
    keys: ["ctrl+shift+a"],
    run: () => addAudioTrack(),
    editor: true,
  },
  {
    group: "Timeline",
    label: "Add image",
    keys: ["ctrl+shift+i"],
    run: () => addImage(),
    editor: true,
  },
  {
    group: "Timeline",
    label: "Linked selection on / off",
    keys: ["ctrl+shift+l"],
    run: toggleLinkedSelection,
    editor: true,
  },
  {
    group: "Timeline",
    label: "Collapse / show removed parts",
    keys: ["h"],
    run: toggleCollapseRemoved,
    editor: true,
  },
  { group: "General", label: "Open video", keys: ["ctrl+o"], run: openDialog },
  {
    group: "General",
    label: "Export",
    keys: ["ctrl+e"],
    run: doExport,
    editor: true,
  },
  {
    group: "General",
    label: "Save current frame",
    keys: ["ctrl+shift+s"],
    run: saveFrame,
    editor: true,
  },
  {
    group: "General",
    label: "Close video",
    keys: ["ctrl+w"],
    run: () => closeSession(),
    editor: true,
  },
  {
    group: "General",
    label: "Inspector panel",
    keys: ["ctrl+p"],
    run: toggleProps,
    editor: true,
  },
  {
    group: "General",
    label: "Clip info",
    keys: ["ctrl+i"],
    run: showInfo,
    editor: true,
  },
  {
    group: "General",
    label: "Edit metadata",
    keys: ["ctrl+shift+m"],
    run: showMetadata,
    editor: true,
  },
  {
    group: "General",
    label: "Toggle sidebar",
    keys: ["ctrl+."],
    run: toggleSidebar,
  },
  { group: "General", label: "Settings", keys: ["ctrl+,"], run: showSettings },
  {
    group: "General",
    label: "Keyboard shortcuts",
    keys: ["?"],
    run: showShortcuts,
  },
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
  "ctrl+x": () => copySelection(true),
  "ctrl+c": () => copySelection(),
  "ctrl+v": () => paste(),
  "+": () => session?.tl.zoomBy(1.5),
  "=": () => session?.tl.zoomBy(1.5),
  "-": () => session?.tl.zoomBy(1 / 1.5),
};
for (const a of actions)
  for (const k of a.keys) keymap.set(k, pairs[k] ? { ...a, run: pairs[k] } : a);
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
    .map(k => KEY_NAMES[k] ?? k.toUpperCase())
    .join(" ");

document.addEventListener("keydown", e => {
  if (modalOpen() || menuOpen()) return;
  const t = e.target as HTMLElement;
  if (
    (t instanceof HTMLInputElement && t.type !== "range") ||
    t instanceof HTMLTextAreaElement ||
    t.isContentEditable
  )
    return;
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
      ...groups.map(g =>
        h(
          "div",
          { class: "sc-group" },
          h("div", { class: "sc-title" }, g),
          ...actions
            .filter(a => a.group === g)
            .map(a =>
              h(
                "div",
                { class: "sc-row" },
                h("span", {}, a.label),
                h(
                  "span",
                  { class: "sc-keys" },
                  ...a.keys.map(k => kbd(keyLabel(k)))
                )
              )
            )
        )
      )
    ),
    h(
      "div",
      { class: "sc-foot" },
      "Timeline: click to seek, drag a cut line to move it, Ctrl + scroll to zoom, Shift + scroll to pan. Drag the line in an audio track to change its volume, drag added tracks and images sideways to move them, and drag an image's edge to change how long it shows. Hold Shift to skip snapping. Right-click anything for more."
    )
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
    s.engine.sync(s.edit.tracks);
    s.layer.tick(t);
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
  document.documentElement.classList.toggle(
    "sb-collapsed",
    store.settings.ui.sidebarCollapsed
  );

  const min = $("win-min");
  const max = $("win-max");
  const close = $("win-close");
  min.append(icon(Minus, 16, 1.5));
  max.append(icon(Square, 13, 1.5));
  close.append(icon(X, 17, 1.5));
  min.addEventListener("click", () => appWindow.minimize());
  max.addEventListener("click", () => appWindow.toggleMaximize());
  close.addEventListener("click", () => appWindow.close());
  // however the window gets closed (our button, the taskbar, Alt+F4), save first
  appWindow.onCloseRequested(() => flushAll());
  if (store.app.channel === "dev")
    $("btn-sidebar").after(
      h(
        "span",
        {
          class: "dev-badge",
          "data-tip": "Local build: its own settings, no automatic updates",
          "data-tip-pos": "below",
        },
        "DEV"
      )
    );
  appWindow.onResized(async () => {
    const maximized = await appWindow.isMaximized();
    max.replaceChildren(
      maximized ? icon(Copy, 13, 1.5) : icon(Square, 13, 1.5)
    );
  });

  // keep focus off buttons so Space/arrows always go to the editor
  document.addEventListener("mousedown", e => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  if (!import.meta.env.DEV)
    document.addEventListener("contextmenu", e => e.preventDefault());

  const dropText = h("div", { class: "drop-text" }, "Drop a video to open it");
  document.body.append(
    h(
      "div",
      { class: "drop-overlay" },
      h(
        "div",
        { class: "drop-inner" },
        h(
          "div",
          { class: "drop-icons" },
          icon(Film, 30, 1.5),
          icon(Clapperboard, 30, 1.5),
          icon(FolderOpen, 30, 1.5)
        ),
        dropText
      )
    )
  );
  getCurrentWebview().onDragDropEvent(e => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") {
      document.body.classList.add("dragging");
      dropText.textContent = session
        ? "Drop a video to open it, or an image or audio file to add it"
        : "Drop a video to open it";
    } else if (p.type === "leave") document.body.classList.remove("dragging");
    else if (p.type === "drop") {
      document.body.classList.remove("dragging");
      // while editing, images and audio files get added to the clip at the playhead
      if (session) {
        const images = p.paths.filter(x => IMAGE_EXTS.includes(ext(x)));
        const sounds = p.paths.filter(
          x => AUDIO_EXTS.includes(ext(x)) && !VIDEO_EXTS.includes(ext(x))
        );
        if (images.length || sounds.length) {
          (async () => {
            for (const f of images) await addImage(undefined, f);
            for (const f of sounds) await addAudioTrack(undefined, f);
          })();
          return;
        }
      }
      const file = p.paths.find(x => VIDEO_EXTS.includes(ext(x)));
      if (file) openFile(file);
      else if (p.paths.length) {
        // a dropped folder becomes a media pool folder
        api
          .listMedia(p.paths[0])
          .then(() => addMediaFolder(p.paths[0]))
          .catch(() =>
            toast("That doesn't look like a video", {
              body: basename(p.paths[0]),
            })
          );
      }
    }
  });
}

async function boot() {
  initTooltips();
  const [, app] = await Promise.all([
    loadState(),
    api.appInfo().catch(() => null),
  ]);
  if (app) store.app = app;
  theme = await loadTheme(store.settings.theme, store.settings.m3);
  setupChrome();
  setBeforeInstall(flushAll);
  autoCheck();
  renderSidebar();
  renderHome();
  requestAnimationFrame(loop);
  startMediaWatch(renderSidebar);

  api.tools().then(t => {
    tools = t;
    renderSidebar();
    if (!session && !opening) renderHome();
    if (session)
      for (const tr of session.edit.tracks) loadTrackMedia(session, tr);
  });
  let reopen: string | null = null;
  try {
    reopen = sessionStorage.getItem("reopen");
    sessionStorage.removeItem("reopen");
  } catch {}
  if (reopen) openFile(reopen);
  else
    api.initialFile().then(p => {
      if (p) openFile(p);
    });
}

boot();
