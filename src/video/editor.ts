import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Camera,
  ChevronsLeft,
  ChevronsRight,
  ChevronsRightLeft,
  Crop,
  Download,
  FoldHorizontal,
  Info,
  Link2,
  PanelRight,
  Pause,
  Play,
  Redo2,
  Scissors,
  StepBack,
  StepForward,
  Trash,
  Undo2,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";

import { api, fileUrl, type Probe } from "../shared/api";
import { saveSettings, store } from "../shared/settings";
import {
  basename,
  fmt,
  fmtDb,
  fmtSize,
  h,
  icon,
  stem,
  toast,
} from "../shared/ui";
import {
  del,
  doExport,
  keepRange,
  markIn,
  markOut,
  nextCut,
  prevCut,
  saveFrame,
  seek,
  speedMenu,
  split,
  stepFrame,
  toggleMute,
  togglePlay,
  trimAfter,
  trimBefore,
} from "./actions";
import { AudioEngine } from "./audio";
import { iconBtn, renderSidebar, setTitle, toolBtn } from "./chrome";
import { type Doc, Edit, type Track } from "./edit";
import { closeSession, restorable, scheduleEditSave } from "./home";
import { stageMenu, timelineMenu } from "./menus";
import {
  getImage,
  IMAGE_EXTS,
  imageSize,
  newOverlay,
  OverlayLayer,
} from "./overlays";
import {
  genThumbs,
  previewFallback,
  setVolume,
  showInfo,
  showMetadata,
  startDock,
  toggleCollapseRemoved,
  toggleLinkedSelection,
  toggleProps,
  updateUI,
  updateVolumeUI,
} from "./panels";
import { renderProps } from "./props";
import {
  AUDIO_EXTS,
  clamp,
  mainEl,
  MarkIn,
  MarkOut,
  session,
  Session,
  setSession,
  tbActions,
  tools,
} from "./state";
import { Timeline } from "./timeline";

// ---- editor

export function sourceTracks(path: string, probe: Probe): Track[] {
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
export function loadTrackMedia(s: Session, t: Track) {
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
export async function addAudioTrack(at?: number, file?: string) {
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
export function frameSize(s: Session): [number, number] {
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
export type ImageOpts = {
  seconds?: number;
  name?: string;
  /** -1, 0 or 1 across and down */
  anchor?: [number, number];
  /** width as a fraction of the frame */
  scale?: number;
  fill?: boolean;
};

export async function addImage(
  at?: number,
  file?: string,
  opts: ImageOpts = {}
) {
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
    const o = newOverlay(
      picked,
      opts.name ?? stem(picked),
      Math.round(start * 1000) / 1000,
      Math.max(0.1, Math.min(opts.seconds ?? 5, dur - start)),
      size.w / size.h,
      fw / fh
    );
    if (opts.fill) o.scale = 1;
    else if (opts.scale) o.scale = opts.scale;
    if (opts.anchor && !opts.fill) {
      // a small margin from the edges; the height follows from the picture's shape
      const m = 0.04;
      const tall = (o.scale * (fw / fh)) / (size.w / size.h);
      o.x =
        Math.round((0.5 + opts.anchor[0] * (0.5 - o.scale / 2 - m)) * 1000) /
        1000;
      o.y =
        Math.round((0.5 + opts.anchor[1] * (0.5 - tall / 2 - m)) * 1000) / 1000;
    }
    s.edit.addItems([o], []);
  } catch {
    toast("Couldn't read that image", { body: basename(picked), error: true });
  }
}

export function applyLook(s: Session) {
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
export let propsFrame = 0;
export let propsBusy = false;
window.addEventListener("pointerup", () => {
  if (!propsBusy) return;
  propsBusy = false;
  if (session) scheduleProps(session);
});
export function scheduleProps(s: Session) {
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

export function splitter(
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

export function buildEditor(path: string, probe: Probe, saved: Doc | null) {
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
  setSession(s);
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
