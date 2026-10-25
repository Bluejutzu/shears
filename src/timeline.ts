import { Film, Image, Link2, Link2Off, Plus } from "lucide";

import type { Edit, Overlay, Track } from "./edit";
import { dbToGain, fmt, fmtDb, h, icon } from "./ui";

const PAD = 14;
const RULER = 26;
const TRACK_TOP = RULER + 6;
const VIDEO_H = 54;
const AUDIO_H = 46;
const LANE_GAP = 4;
const OVER_H = 34; // image overlay lanes, stacked above the video
const SEP = 12; // space for the line between the video and the audio tracks
const ADD_ROW = 30; // room for the "+ Audio track" button under the last track
const BOTTOM = 26; // minimap strip
const MINI = 6;
const COLLAPSED_PX = 16; // width of a removed part when they're collapsed
const CUT_GAP = 5; // visible gap between parts after a cut
const MAX_ZOOM = 900; // px per second
const HIT = 6;
const DB_MIN = -30;
const DB_MAX = 12;

const C = {
  clip: "#3a3935",
  audioClip: "#343935",
  imageClip: "#37364a",
  clipOff: "#2a2927",
  lane: "rgba(245,244,239,0.025)",
  border: "rgba(222,220,209,0.13)",
  selected: "#ecebe4",
  wave: "#93b39b",
  waveMuted: "#5f6360",
  waveOff: "#4f524f",
  dim: "rgba(31,30,29,0.6)",
  hatch: "rgba(222,220,209,0.08)",
  tick: "rgba(222,220,209,0.2)",
  label: "#8a887f",
  range: "rgba(245,244,239,0.08)",
  rangeEdge: "#ecebe4",
  playhead: "#4b9bff",
  hover: "rgba(245,244,239,0.28)",
  pill: "#3a3935",
  pillText: "#ecebe4",
  mini: "#5d5b55",
  miniOff: "#34332f",
  volLine: "rgba(236,235,228,0.6)",
  volActive: "#4b9bff",
};
const DEFAULT_COLORS = { ...C };

/** Themes can recolor the canvas through --tl-* variables (e.g. --tl-audio-clip). */
export function loadTimelineColors() {
  const css = getComputedStyle(document.documentElement);
  for (const key of Object.keys(DEFAULT_COLORS) as (keyof typeof C)[]) {
    const name = `--tl-${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`;
    C[key] = css.getPropertyValue(name).trim() || DEFAULT_COLORS[key];
  }
}

type Lane =
  | { kind: "video"; y: number; h: number }
  | { kind: "audio"; y: number; h: number; track: Track }
  | { kind: "image"; y: number; h: number; overlay: Overlay };

type Drag =
  | { kind: "scrub" }
  | { kind: "cut"; k: number }
  | { kind: "mark"; which: "in" | "out" }
  | { kind: "mini"; offset: number }
  | { kind: "gain"; id: string; y: number; from: number }
  | { kind: "move"; id: string; grab: number; from: number }
  | { kind: "trim"; id: string; edge: "start" | "end"; from: [number, number] }
  | { kind: "vscroll"; grab: number; from: number }
  | null;

/** What a right-click landed on. `t` is the source time under the mouse. */
export type Target = {
  t: number;
  area: "ruler" | "video" | "audio" | "image" | "empty";
  /** track or overlay id */
  id?: string;
  /** on an added file or image itself, not the empty lane around it */
  onClip?: boolean;
  header?: boolean;
};

type Hooks = {
  time: () => number;
  seek: (t: number) => void;
  peaks: (id: string) => Uint8Array | null;
  image: (path: string) => HTMLImageElement | null;
  addTrack: () => void;
  changed: () => void;
  linkedSelection: () => boolean;
  collapseRemoved: () => boolean;
  menu: (target: Target, e: MouseEvent) => void;
};

type Reorder = {
  id: string;
  from: number;
  to: number;
  startY: number;
  grabY: number;
  y: number;
  moved: boolean;
};

const dbNorm = (db: number) =>
  (Math.min(Math.max(db, DB_MIN), DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN);
const laneId = (lane: Lane) =>
  lane.kind === "video"
    ? "video"
    : lane.kind === "image"
      ? lane.overlay.id
      : lane.track.id;

export class Timeline {
  readonly canvas = document.createElement("canvas");
  private headers = h("div", { class: "tl-headers" });
  // audio headers live in their own clipped box so they scroll with the audio lanes
  private audioHeads = h("div", { class: "tl-audio-heads" });
  private audioInner = h("div", { class: "tl-audio-inner" });
  private rows = new Map<string, HTMLElement>();
  private addBtn: HTMLElement;
  private sep = h("div", { class: "tl-sep" });
  private vscroll = 0;
  private trackCount = 0;
  private ctx = this.canvas.getContext("2d")!;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private fitted = true;
  private hoverX = -1;
  private hoverY = -1;
  private drag: Drag = null;
  private reorder: Reorder | null = null;
  private animY = new Map<string, number>();
  private dirty = true;
  private lastTime = -1;
  private ro: ResizeObserver;
  private canvasWrap: HTMLElement;
  zoom = 1;
  scroll = 0;
  thumbs: (HTMLCanvasElement | undefined)[] = [];
  thumbStep = 1;

  constructor(
    private host: HTMLElement,
    private edit: Edit,
    public aspect: number,
    private hooks: Hooks
  ) {
    this.canvas.className = "timeline-canvas";
    loadTimelineColors();
    this.canvasWrap = h("div", { class: "tl-canvas" }, this.canvas);
    this.addBtn = h(
      "button",
      {
        class: "tl-add",
        "data-tip": "Add an audio file as a new track",
        onclick: () => this.hooks.addTrack(),
      },
      icon(Plus, 13),
      "Audio track"
    );
    this.audioInner.append(this.addBtn);
    this.audioHeads.append(this.audioInner);
    this.headers.append(this.sep, this.audioHeads);
    this.headers.addEventListener("wheel", e => this.onWheel(e, true), {
      passive: false,
    });
    this.canvas.addEventListener("contextmenu", e => this.onContext(e));
    // right-clicking the empty space under the headers acts like the empty timeline
    this.headers.addEventListener("contextmenu", e => {
      const t = e.target;
      if (t !== this.headers && t !== this.audioHeads && t !== this.audioInner)
        return;
      e.preventDefault();
      this.hooks.menu({ t: this.hooks.time(), area: "empty" }, e);
    });
    host.append(this.headers, this.canvasWrap);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvasWrap);
    this.ro.observe(host);
    this.canvas.addEventListener("pointerdown", e => this.onDown(e));
    this.canvas.addEventListener("pointermove", e => this.onMove(e));
    this.canvas.addEventListener("pointerup", () => this.onUp());
    this.canvas.addEventListener("pointercancel", () => this.onUp());
    this.canvas.addEventListener("dblclick", e => this.onDouble(e));
    this.canvas.addEventListener("pointerleave", () => {
      this.hoverX = -1;
      this.invalidate();
    });
    this.canvas.addEventListener("wheel", e => this.onWheel(e), {
      passive: false,
    });
    this.trackCount = edit.tracks.length;
    this.refresh();
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
    this.headers.remove();
  }

  invalidate() {
    this.dirty = true;
  }

  private get dur() {
    return this.edit.duration;
  }

  // ---- layout: image lanes on top (the last overlay highest), then V1, the separator, then audio

  /** Top of the video lane, pushed down by the image lanes above it. */
  private get videoY() {
    return TRACK_TOP + this.edit.overlays.length * (OVER_H + LANE_GAP);
  }

  private get videoBottom() {
    return this.videoY + VIDEO_H;
  }

  private get audioTop() {
    return this.videoBottom + SEP;
  }

  /** Top of audio track i, as if the audio area weren't scrolled. */
  private slotY(i: number) {
    return this.audioTop + i * (AUDIO_H + LANE_GAP);
  }

  /** Top of overlay i; 0 is the bottom of the stack, right above the video. */
  private overY(i: number) {
    return this.videoY - (i + 1) * (OVER_H + LANE_GAP);
  }

  private imageLanes(): Lane[] {
    return this.edit.overlays.map((overlay, i) => ({
      kind: "image" as const,
      y: this.overY(i),
      h: OVER_H,
      overlay,
    }));
  }

  /** Lanes in their real order and on-screen position, used for clicking and dragging. */
  private lanes(): Lane[] {
    return [
      ...this.imageLanes(),
      { kind: "video", y: this.videoY, h: VIDEO_H },
      ...this.edit.tracks.map((track, i) => ({
        kind: "audio" as const,
        y: this.slotY(i) - this.vscroll,
        h: AUDIO_H,
        track,
      })),
    ];
  }

  private get audioViewH() {
    return Math.max(0, this.hgt - this.audioTop - BOTTOM);
  }

  private get audioContentH() {
    return this.edit.tracks.length * (AUDIO_H + LANE_GAP) + ADD_ROW;
  }

  private get maxV() {
    return Math.max(0, this.audioContentH - this.audioViewH);
  }

  private inAudio(y: number) {
    return (
      y >= this.audioTop - LANE_GAP && y <= this.audioTop + this.audioViewH
    );
  }

  private scrollAudio(to: number) {
    const v = Math.min(Math.max(to, 0), this.maxV);
    if (v === this.vscroll) return;
    this.vscroll = v;
    this.audioInner.style.transform = `translateY(${-this.audioTop - v}px)`;
    this.invalidate();
  }

  /** Track order including a reorder drag that's in progress. */
  private ordered(): Track[] {
    const tracks = this.edit.tracks;
    const r = this.reorder;
    if (!r?.moved || !tracks[r.from]) return tracks;
    const list = tracks.filter(t => t.id !== r.id);
    list.splice(r.to, 0, tracks[r.from]);
    return list;
  }

  /** Where a lane should sit right now: the dragged one follows the mouse, the rest slide to their slots. */
  private targetY(id: string, i: number) {
    const r = this.reorder;
    return r?.moved && r.id === id ? r.y : this.slotY(i);
  }

  /** Lanes as drawn, easing toward their slots so reordering moves smoothly. */
  private shownLanes(): Lane[] {
    const lanes: Lane[] = [
      ...this.imageLanes(),
      { kind: "video", y: this.videoY, h: VIDEO_H },
    ];
    this.ordered().forEach((track, i) => {
      const target = this.targetY(track.id, i);
      const dragging = this.reorder?.moved && this.reorder.id === track.id;
      const cur = this.animY.get(track.id);
      let y = target;
      if (!dragging && cur != null && Math.abs(cur - target) > 0.5) {
        y = cur + (target - cur) * 0.3;
        this.dirty = true;
      }
      this.animY.set(track.id, y);
      lanes.push({ kind: "audio", y: y - this.vscroll, h: AUDIO_H, track });
    });
    // draw the dragged lane last so it sits on top
    const r = this.reorder;
    if (r?.moved)
      lanes.sort(
        (a, b) => Number(laneId(a) === r.id) - Number(laneId(b) === r.id)
      );
    return lanes;
  }

  /** Bottom of the last visible lane on screen. */
  private get lanesBottom() {
    const n = this.edit.tracks.length;
    if (!n) return this.videoBottom;
    return Math.min(
      this.slotY(n) - LANE_GAP - this.vscroll,
      this.audioTop + this.audioViewH
    );
  }

  private get miniTop() {
    return this.hgt - BOTTOM + 10;
  }

  /** Height that fits every track; the panel can squeeze it, and then the audio area scrolls. */
  private get naturalHeight() {
    return this.audioTop + this.audioContentH + BOTTOM;
  }

  /** Update track headers and size for the current tracks. Call after tracks change. */
  refresh() {
    this.host.style.height = `${this.naturalHeight}px`;
    this.host.style.minHeight = `${this.audioTop + Math.min(this.audioContentH, AUDIO_H + ADD_ROW) + BOTTOM}px`;
    const added = this.edit.tracks.length > this.trackCount;
    this.trackCount = this.edit.tracks.length;
    this.resize(true);
    // show a newly added track instead of leaving it hidden below the fold
    if (added) this.scrollAudio(this.maxV);
    else this.scrollAudio(this.vscroll);
    this.syncHeaders();
    this.invalidate();
  }

  private select(id: string, add: boolean) {
    this.edit.selectLane(id, this.hooks.linkedSelection(), add);
    this.hooks.changed();
  }

  private headerContent(id: string, n: number) {
    const e = this.edit;
    if (id === "video")
      return [
        h("span", { class: "tl-tag" }, "V1"),
        icon(Film, 14),
        h("span", { class: "tl-name" }, "Video"),
      ];
    const o = e.overlay(id);
    if (o)
      return [
        h("span", { class: "tl-tag" }, `V${n}`),
        icon(Image, 14),
        h("span", { class: "tl-name", title: o.name }, o.name),
      ];
    const t = e.track(id)!;
    const flag = (
      label: string | Node,
      on: boolean,
      cls: string,
      tip: string,
      patch: Partial<Track>
    ) =>
      h(
        "button",
        {
          class: `tl-flag ${cls}${on ? " on" : ""}`,
          "data-tip": tip,
          onclick: (ev: MouseEvent) => {
            ev.stopPropagation();
            e.updateTrack(t.id, patch);
          },
        },
        label
      );
    return [
      h("span", { class: "tl-tag" }, `A${n}`),
      h(
        "div",
        { class: "tl-meta" },
        h("span", { class: "tl-name", title: t.name }, t.name),
        h("span", { class: "tl-db" }, fmtDb(t.gainDb))
      ),
      flag(
        icon(t.linked ? Link2 : Link2Off, 12),
        t.linked,
        "link",
        t.linked
          ? "Linked to the video: selected together"
          : "Not linked: selected on its own",
        { linked: !t.linked }
      ),
      flag("M", t.muted, "mute", "Mute track", { muted: !t.muted }),
      flag("S", t.solo, "solo", "Solo: only hear this track (preview only)", {
        solo: !t.solo,
      }),
    ];
  }

  /** Header rows stay the same elements and move with transforms, so CSS can animate reordering. */
  private syncHeaders() {
    const e = this.edit;
    const want = new Set([
      "video",
      ...e.tracks.map(t => t.id),
      ...e.overlays.map(o => o.id),
    ]);
    for (const [id, el] of this.rows) {
      if (!want.has(id)) {
        el.remove();
        this.rows.delete(id);
        this.animY.delete(id);
      }
    }
    const place = (id: string, y: number, hgt: number, n: number) => {
      const t = e.track(id);
      let el = this.rows.get(id);
      const fresh = !el;
      if (!el) {
        el = this.makeRow(id);
        this.rows.set(id, el);
        if (t) this.audioInner.prepend(el);
        else this.headers.prepend(el);
      }
      el.className = `tl-head${t ? " audio" : e.overlay(id) ? " image" : ""}${e.isSelected(id) ? " selected" : ""}${t?.muted ? " muted" : ""}${this.reorder?.moved && this.reorder.id === id ? " dragging" : ""}`;
      el.style.height = `${hgt}px`;
      el.replaceChildren(...this.headerContent(id, n));
      if (fresh) {
        el.style.transition = "none";
        el.style.transform = `translateY(${y}px)`;
        void el.offsetHeight;
        el.style.transition = "";
      } else {
        el.style.transform = `translateY(${y}px)`;
      }
    };
    e.overlays.forEach((o, i) => place(o.id, this.overY(i), OVER_H, i + 2));
    place("video", this.videoY, VIDEO_H, 1);
    this.ordered().forEach((t, i) =>
      place(t.id, this.targetY(t.id, i), AUDIO_H, i + 1)
    );
    this.sep.style.top = `${this.videoBottom + SEP / 2}px`;
    this.audioHeads.style.top = `${this.audioTop}px`;
    this.audioInner.style.transform = `translateY(${-this.audioTop - this.vscroll}px)`;
    this.headers.style.height = `${this.hgt}px`;
    this.audioHeads.style.height = `${this.audioViewH}px`;
    this.addBtn.style.transform = `translateY(${this.slotY(e.tracks.length) + 2}px)`;
  }

  private makeRow(id: string) {
    const el = h("div", { class: "tl-head" });
    el.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      if (!this.edit.isSelected(id)) this.select(id, false);
      const area =
        id === "video" ? "video" : this.edit.overlay(id) ? "image" : "audio";
      this.hooks.menu(
        {
          t: this.hooks.time(),
          area,
          id: id === "video" ? undefined : id,
          header: true,
        },
        ev
      );
    });
    el.addEventListener("pointerdown", ev => {
      if (ev.button !== 0 || (ev.target as HTMLElement).closest("button"))
        return;
      const from = this.edit.tracks.findIndex(t => t.id === id);
      if (id === "video" || from < 0) {
        this.select(id, ev.ctrlKey || ev.metaKey);
        return;
      }
      el.setPointerCapture(ev.pointerId);
      this.reorder = {
        id,
        from,
        to: from,
        startY: ev.clientY,
        grabY: this.slotY(from),
        y: this.slotY(from),
        moved: false,
      };
    });
    el.addEventListener("pointermove", ev => {
      const r = this.reorder;
      if (!r || r.id !== id) return;
      const dy = ev.clientY - r.startY;
      if (!r.moved && Math.abs(dy) < 4) return;
      r.moved = true;
      const last = this.edit.tracks.length - 1;
      r.y = Math.min(
        Math.max(r.grabY + dy, this.slotY(0) - 8),
        this.slotY(last) + 8
      );
      r.to = Math.min(
        Math.max(Math.round((r.y - this.slotY(0)) / (AUDIO_H + LANE_GAP)), 0),
        last
      );
      this.syncHeaders();
      this.invalidate();
    });
    const finish = (ev: PointerEvent) => {
      const r = this.reorder;
      if (!r || r.id !== id) return;
      this.reorder = null;
      if (!r.moved) {
        this.select(id, ev.ctrlKey || ev.metaKey);
        return;
      }
      // keep the lane where it was dropped so it eases into its new slot instead of jumping
      this.animY.set(id, r.y);
      if (!this.edit.moveTrack(r.from, r.to)) this.syncHeaders();
      this.invalidate();
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    return el;
  }

  // ---- time <-> pixels
  // With "collapse removed parts" on, every removed part shrinks to a thin marker, so the
  // timeline runs on a "view time" where kept parts keep their length and removed ones
  // take COLLAPSED_PX. this.scroll is in view time.

  private get collapsed() {
    return this.hooks.collapseRemoved();
  }

  private viewLen(i: number) {
    const s = this.edit.segs[i];
    return this.collapsed && !s.on ? COLLAPSED_PX / this.zoom : s.end - s.start;
  }

  /** Source time -> view time. */
  private v(t: number) {
    if (!this.collapsed) return t;
    const segs = this.edit.segs;
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const len = this.viewLen(i);
      if (t <= s.end || i === segs.length - 1) {
        const into = Math.min(Math.max(t, s.start), s.end) - s.start;
        return acc + (into / Math.max(s.end - s.start, 1e-9)) * len;
      }
      acc += len;
    }
    return acc;
  }

  /** View time -> source time. */
  private vinv(v: number) {
    if (!this.collapsed) return v;
    const segs = this.edit.segs;
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const len = this.viewLen(i);
      if (v <= acc + len || i === segs.length - 1) {
        const into = Math.min(Math.max(v - acc, 0), len);
        return s.start + (into / Math.max(len, 1e-9)) * (s.end - s.start);
      }
      acc += len;
    }
    return this.dur;
  }

  private x(t: number) {
    return PAD + (this.v(t) - this.scroll) * this.zoom;
  }

  private t(x: number) {
    return this.vinv(this.scroll + (x - PAD) / this.zoom);
  }

  private clampT(t: number) {
    return Math.min(Math.max(t, 0), this.dur);
  }

  private get visible() {
    return (this.w - PAD * 2) / this.zoom;
  }

  private fitZoom() {
    const span = this.w - PAD * 2;
    if (this.collapsed) {
      const removed = this.edit.segs.filter(s => !s.on).length;
      const kept = this.edit.outDuration();
      if (kept > 0)
        return Math.max(1e-3, (span - removed * COLLAPSED_PX) / kept);
    }
    return Math.max(1e-3, span / this.dur);
  }

  /** Keep the zoom valid after cuts change how much there is to show. */
  private syncZoom() {
    const fit = this.fitZoom();
    this.zoom = this.fitted ? fit : Math.max(this.zoom, fit);
    this.clampScroll();
  }

  private resize(force = false) {
    const w = this.canvasWrap.clientWidth;
    const hgt = Math.max(this.host.clientHeight, this.audioTop + BOTTOM);
    if (
      !force &&
      w === this.w &&
      hgt === this.hgt &&
      devicePixelRatio === this.dpr
    )
      return;
    const heightChanged = hgt !== this.hgt;
    this.w = w;
    this.hgt = hgt;
    this.dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(hgt * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    if (this.fitted) this.zoom = this.fitZoom();
    this.zoom = Math.max(this.zoom, this.fitZoom());
    this.clampScroll();
    if (heightChanged) {
      this.scrollAudio(this.vscroll);
      this.headers.style.height = `${hgt}px`;
      this.audioHeads.style.height = `${this.audioViewH}px`;
    }
    this.dirty = true;
    this.render();
  }

  private clampScroll() {
    this.scroll = Math.min(
      Math.max(this.scroll, 0),
      Math.max(0, this.v(this.dur) - this.visible)
    );
  }

  fit() {
    this.zoom = this.fitZoom();
    this.scroll = 0;
    this.fitted = true;
    this.dirty = true;
  }

  zoomAt(x: number, factor: number) {
    const t = this.t(x);
    const fit = this.fitZoom();
    this.zoom = Math.min(Math.max(this.zoom * factor, fit), MAX_ZOOM);
    this.fitted = this.zoom <= fit * 1.0001;
    this.scroll = this.v(t) - (x - PAD) / this.zoom;
    this.clampScroll();
    this.dirty = true;
  }

  /** Zoom around the playhead if it's on screen, otherwise around the middle. */
  zoomBy(factor: number) {
    const px = this.x(this.hooks.time());
    this.zoomAt(px >= PAD && px <= this.w - PAD ? px : this.w / 2, factor);
  }

  /** Keep the playhead on screen while playing. */
  follow(t: number) {
    const px = this.x(t);
    if (px > this.w - PAD - 16 || px < PAD) {
      this.scroll = this.v(t) - this.visible * 0.08;
      this.clampScroll();
      this.dirty = true;
    }
  }

  render() {
    const time = this.hooks.time();
    if (!this.dirty && time === this.lastTime) return;
    this.dirty = false;
    this.lastTime = time;
    this.draw(time);
  }

  // ---- drawing

  private draw(time: number) {
    const { ctx, w } = this;
    this.syncZoom();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, this.hgt);
    ctx.font =
      "11px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
    ctx.textBaseline = "middle";

    this.drawRuler();
    const lanes = this.shownLanes();
    const video = lanes.filter(l => l.kind !== "audio");
    const audio = lanes.filter(l => l.kind === "audio");
    for (const lane of video)
      if (lane.kind === "image") this.drawImageLane(lane);
      else this.drawLane(lane);
    this.drawSelection(video);

    // separator between the pinned video lane and the scrolling audio tracks
    ctx.fillStyle = C.border;
    ctx.fillRect(0, this.videoBottom + SEP / 2, w, 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.audioTop - 2, w, this.audioViewH + 2);
    ctx.clip();
    for (const lane of audio) this.drawLane(lane);
    this.drawSelection(audio);
    if (this.vscroll > 0) {
      // soft fade under the separator so it's clear there's more above
      const g = ctx.createLinearGradient(
        0,
        this.audioTop - 2,
        0,
        this.audioTop + 12
      );
      g.addColorStop(0, "rgba(48,48,46,0.95)");
      g.addColorStop(1, "rgba(48,48,46,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, this.audioTop - 2, w, 14);
    }
    ctx.restore();

    this.drawRange();
    this.drawHover();
    this.drawPlayhead(time);
    this.drawScrollbar();
    this.drawMini(time);
  }

  private scrollbarRect() {
    const view = this.audioViewH;
    const content = this.audioContentH;
    if (content <= view || view <= 0) return null;
    const h = Math.max(24, (view / content) * view);
    const y = this.audioTop + (this.vscroll / this.maxV) * (view - h);
    return { x: this.w - 7, y, w: 5, h };
  }

  private drawScrollbar() {
    const r = this.scrollbarRect();
    if (!r) return;
    const { ctx } = this;
    const hot =
      this.drag?.kind === "vscroll" ||
      (this.hoverX >= this.w - 12 &&
        this.hoverY >= r.y &&
        this.hoverY <= r.y + r.h);
    ctx.fillStyle = hot ? "rgba(245,244,239,0.45)" : "rgba(245,244,239,0.22)";
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 3);
    ctx.fill();
  }

  private drawRuler() {
    const { ctx } = this;
    const steps = [
      0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600,
    ];
    const step = steps.find(s => s * this.zoom >= 84) ?? 3600;
    const minor = step / 5;
    const showMinor = minor * this.zoom >= 7;
    const end = this.clampT(this.t(this.w));
    const first = Math.floor(this.clampT(this.t(0)) / minor) * minor;
    for (let i = 0; ; i++) {
      const t = first + i * minor;
      if (t > end + 1e-9) break;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      if (!major && !showMinor) continue;
      // collapsed removed parts are too thin for ticks
      if (this.collapsed && !this.edit.isKept(t)) continue;
      const x = Math.round(this.x(t)) + 0.5;
      ctx.fillStyle = C.tick;
      ctx.fillRect(x - 0.5, major ? RULER - 9 : RULER - 5, 1, major ? 9 : 5);
      if (major) {
        ctx.fillStyle = C.label;
        ctx.fillText(
          step < 1 ? fmt(t).replace(/(\.\d)\d$/, "$1") : fmt(t, false),
          x + 4,
          10
        );
      }
    }
  }

  /** Screen span of segment i, leaving a gap at cuts. */
  private segSpan(i: number): [number, number] {
    const segs = this.edit.segs;
    const x0 = this.x(segs[i].start) + (i > 0 ? CUT_GAP / 2 : 0);
    const x1 = this.x(segs[i].end) - (i < segs.length - 1 ? CUT_GAP / 2 : 0);
    return [x0, Math.max(x1, x0 + 2)];
  }

  private drawLane(lane: Lane) {
    const { ctx } = this;
    const segs = this.edit.segs;
    ctx.fillStyle = C.lane;
    ctx.beginPath();
    ctx.roundRect(PAD - 4, lane.y, this.x(this.dur) - PAD + 8, lane.h, 7);
    ctx.fill();

    const track = lane.kind === "audio" ? lane.track : null;
    // file tracks only cover part of the timeline
    const from = track?.kind === "file" ? track.offset : 0;
    const to =
      track?.kind === "file" ? track.offset + track.duration : this.dur;

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let [x0, x1] = this.segSpan(i);
      if (s.end <= from || s.start >= to) continue;
      if (from > s.start) x0 = Math.max(x0, this.x(from));
      if (to < s.end) x1 = Math.min(x1, this.x(to));
      if (x1 < 0 || x0 > this.w || x1 - x0 < 1) continue;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, lane.y, x1 - x0, lane.h, 6);
      ctx.clip();
      ctx.fillStyle = !s.on
        ? C.clipOff
        : lane.kind === "video"
          ? C.clip
          : C.audioClip;
      ctx.fillRect(x0, lane.y, x1 - x0, lane.h);
      // removed parts stay quiet (no frames or waveform) so the kept parts stand out
      if (s.on) {
        if (lane.kind === "video") this.drawThumbs(x0, x1, lane.y, lane.h);
        else if (lane.kind === "audio")
          this.drawWave(lane.track, x0, x1, lane.y, lane.h, true);
      } else {
        ctx.strokeStyle = C.hatch;
        ctx.lineWidth = 6;
        ctx.beginPath();
        for (
          let hx = x0 - lane.h - ((x0 + this.scroll * this.zoom) % 16);
          hx < x1;
          hx += 16
        ) {
          ctx.moveTo(hx, lane.y + lane.h);
          ctx.lineTo(hx + lane.h, lane.y);
        }
        ctx.stroke();
      }
      ctx.restore();

      if (s.on) {
        ctx.beginPath();
        ctx.roundRect(x0 + 0.5, lane.y + 0.5, x1 - x0 - 1, lane.h - 1, 6);
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (track) this.drawVolume(track, lane, from, to);
  }

  private imageSpan(o: Overlay): [number, number] {
    const x0 = this.x(o.start);
    return [x0, Math.max(this.x(o.start + o.duration), x0 + 4)];
  }

  /** An image overlay: one block from its start to its end, tiled with the picture. */
  private drawImageLane(lane: Extract<Lane, { kind: "image" }>) {
    const { ctx } = this;
    const o = lane.overlay;
    ctx.fillStyle = C.lane;
    ctx.beginPath();
    ctx.roundRect(PAD - 4, lane.y, this.x(this.dur) - PAD + 8, lane.h, 7);
    ctx.fill();
    const [x0, x1] = this.imageSpan(o);
    if (x1 < 0 || x0 > this.w) return;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0, lane.y, x1 - x0, lane.h, 6);
    ctx.clip();
    ctx.fillStyle = C.imageClip;
    ctx.fillRect(x0, lane.y, x1 - x0, lane.h);
    const img = this.hooks.image(o.path);
    if (img?.naturalWidth) {
      const tw = (lane.h * img.naturalWidth) / img.naturalHeight;
      ctx.globalAlpha = 0.85;
      for (
        let sx = x0 + Math.max(0, Math.floor(-x0 / tw)) * tw;
        sx < Math.min(x1, this.w);
        sx += tw
      )
        ctx.drawImage(img, sx, lane.y, tw, lane.h);
      ctx.globalAlpha = 1;
    }
    // it won't show where the video is cut out
    ctx.fillStyle = C.dim;
    for (const s of this.edit.segs)
      if (!s.on && s.end > o.start && s.start < o.start + o.duration)
        ctx.fillRect(
          this.x(s.start),
          lane.y,
          this.x(s.end) - this.x(s.start),
          lane.h
        );
    const label = o.name;
    const tw = ctx.measureText(label).width + 12;
    if (x1 - x0 > tw + 8) {
      const lx = Math.max(x0, 0) + 4;
      ctx.fillStyle = C.pill;
      ctx.beginPath();
      ctx.roundRect(lx, lane.y + 4, tw, 16, 5);
      ctx.fill();
      ctx.fillStyle = C.pillText;
      ctx.fillText(label, lx + 6, lane.y + 12);
    }
    ctx.restore();

    ctx.beginPath();
    if (this.edit.isSelected(o.id)) {
      ctx.roundRect(x0 - 0.5, lane.y - 0.5, x1 - x0 + 1, lane.h + 1, 6.5);
      ctx.strokeStyle = C.selected;
      ctx.lineWidth = 2;
    } else {
      ctx.roundRect(x0 + 0.5, lane.y + 0.5, x1 - x0 - 1, lane.h - 1, 6);
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 1;
    }
    ctx.stroke();
  }

  private drawThumbs(x0: number, x1: number, y: number, hgt: number) {
    if (!this.thumbs.length) return;
    const tw = hgt * this.aspect;
    const origin = this.x(0);
    const first = origin + Math.floor((Math.max(x0, 0) - origin) / tw) * tw;
    for (let sx = first; sx < Math.min(x1, this.w); sx += tw) {
      const img = this.thumbAt(this.t(sx + tw / 2));
      if (img) this.ctx.drawImage(img, sx, y, tw, hgt);
    }
  }

  /** Closest filmstrip frame to a source time (used by the export screen too). */
  thumbAt(t: number) {
    const n = this.thumbs.length;
    const i = Math.min(Math.max(Math.round(t / this.thumbStep), 0), n - 1);
    for (let d = 0; d < n; d++) {
      const img = this.thumbs[i - d] ?? this.thumbs[i + d];
      if (img) return img;
    }
    return undefined;
  }

  private drawWave(
    track: Track,
    x0: number,
    x1: number,
    y: number,
    hgt: number,
    on: boolean
  ) {
    const peaks = this.hooks.peaks(track.id);
    if (!peaks?.length) return;
    const { ctx } = this;
    const mid = y + hgt / 2;
    const amp = hgt / 2 - 3;
    const gain = dbToGain(track.gainDb);
    const shift = track.kind === "file" ? track.offset : 0;
    ctx.fillStyle = !on ? C.waveOff : track.muted ? C.waveMuted : C.wave;
    ctx.beginPath();
    const from = Math.max(Math.floor(x0), 0);
    const to = Math.min(x1, this.w);
    for (let px = from; px < to; px += 2) {
      const i0 = Math.max(0, Math.floor((this.t(px) - shift) * 100));
      const i1 = Math.min(
        peaks.length,
        Math.max(i0 + 1, Math.ceil((this.t(px + 2) - shift) * 100))
      );
      let m = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
      const hh = Math.min(
        amp,
        Math.max(0.6, (m / 255) * amp * Math.sqrt(gain))
      );
      ctx.rect(px, mid - hh, 1.3, hh * 2);
    }
    ctx.fill();
  }

  private volY(track: Track, lane: Lane) {
    return lane.y + 5 + (lane.h - 10) * (1 - dbNorm(track.gainDb));
  }

  /** The volume line with its little handle you can drag up and down, like Resolve's clip volume. */
  private drawVolume(track: Track, lane: Lane, from: number, to: number) {
    const { ctx } = this;
    const x0 = Math.max(this.x(from), PAD - 4);
    const x1 = Math.min(this.x(to), this.w);
    if (x1 <= x0) return;
    const y = Math.round(this.volY(track, lane)) + 0.5;
    const active =
      (this.drag?.kind === "gain" && this.drag.id === track.id) ||
      this.hoverGain() === track.id;
    ctx.strokeStyle = active ? C.volActive : C.volLine;
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    // the handle only shows while the mouse is over the lane, so idle tracks stay clean
    const bx = Math.min(x0 + 12, x1 - 6);
    const hovered =
      this.hoverX >= 0 &&
      !this.reorder?.moved &&
      this.hoverY >= lane.y &&
      this.hoverY <= lane.y + lane.h &&
      this.inAudio(this.hoverY);
    if (active || hovered) {
      ctx.fillStyle = active ? C.volActive : "#ecebe4";
      ctx.beginPath();
      ctx.arc(bx, y, active ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (active) {
      const label = fmtDb(track.gainDb);
      const tw = ctx.measureText(label).width + 12;
      const ly = Math.min(Math.max(y - 8, lane.y + 1), lane.y + lane.h - 17);
      ctx.fillStyle = C.pill;
      ctx.beginPath();
      ctx.roundRect(bx + 10, ly, tw, 16, 5);
      ctx.fill();
      ctx.fillStyle = C.pillText;
      ctx.fillText(label, bx + 16, ly + 8);
    }
  }

  /** Outline the selected part on every selected lane, like linked clips lighting up together. */
  private drawSelection(lanes: Lane[]) {
    const i = this.edit.sel;
    if (i < 0 || i >= this.edit.segs.length) return;
    const s = this.edit.segs[i];
    const { ctx } = this;
    ctx.strokeStyle = C.selected;
    ctx.lineWidth = 2;
    // a selected removed part gets a softer outline so it doesn't outshine what's kept
    ctx.globalAlpha = s.on ? 1 : 0.4;
    for (const lane of lanes) {
      if (lane.kind === "image" || !this.edit.isSelected(laneId(lane)))
        continue;
      let [x0, x1] = this.segSpan(i);
      if (lane.kind === "audio" && lane.track.kind === "file") {
        const { offset, duration } = lane.track;
        if (s.end <= offset || s.start >= offset + duration) continue;
        if (offset > s.start) x0 = Math.max(x0, this.x(offset));
        if (offset + duration < s.end)
          x1 = Math.min(x1, this.x(offset + duration));
      }
      ctx.beginPath();
      ctx.roundRect(x0 - 0.5, lane.y - 0.5, x1 - x0 + 1, lane.h + 1, 6.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawRange() {
    const r = this.edit.range();
    if (!r) return;
    const { ctx } = this;
    const a = this.x(r[0]);
    const b = this.x(r[1]);
    const bottom = this.lanesBottom;
    ctx.fillStyle = C.range;
    ctx.fillRect(a, TRACK_TOP, b - a, bottom - TRACK_TOP);
    ctx.fillStyle = C.rangeEdge;
    ctx.fillRect(a, RULER - 3, b - a, 3);
    const edge = (x: number, dir: 1 | -1) => {
      ctx.fillRect(x - (dir === 1 ? 0 : 2), RULER - 8, 2, bottom - RULER + 10);
      ctx.fillRect(x - (dir === 1 ? 0 : 7), RULER - 8, 7, 2);
      ctx.fillRect(x - (dir === 1 ? 0 : 7), bottom, 7, 2);
    };
    if (this.edit.inPt != null) edge(a, 1);
    if (this.edit.outPt != null) edge(b, -1);
  }

  private drawHover() {
    if (
      this.hoverX < 0 ||
      this.drag ||
      this.hoverY > this.miniTop - 4 ||
      this.hoverGain()
    )
      return;
    const { ctx } = this;
    const x = Math.round(this.hoverX) + 0.5;
    ctx.fillStyle = C.hover;
    ctx.fillRect(x - 0.5, RULER, 1, this.lanesBottom - RULER);
    const t = this.clampT(this.t(this.hoverX));
    const seg = this.edit.segs[this.edit.indexAt(t)];
    // collapsed removed parts are just a sliver, so say what's hidden there
    const label =
      this.collapsed && !seg.on
        ? `Removed · ${fmt(seg.end - seg.start, false)}`
        : fmt(t);
    const tw = ctx.measureText(label).width + 12;
    const lx = Math.min(Math.max(x - tw / 2, 2), this.w - tw - 2);
    ctx.fillStyle = C.pill;
    ctx.beginPath();
    ctx.roundRect(lx, 2, tw, 17, 5);
    ctx.fill();
    ctx.fillStyle = C.pillText;
    ctx.fillText(label, lx + 6, 11);
  }

  private drawPlayhead(time: number) {
    const { ctx } = this;
    const x = Math.round(this.x(time)) + 0.5;
    if (x < -10 || x > this.w + 10) return;
    ctx.fillStyle = C.playhead;
    ctx.fillRect(x - 1, 8, 2, this.lanesBottom - 6);
    ctx.beginPath();
    ctx.roundRect(x - 6, 3, 12, 14, 3);
    ctx.fill();
  }

  private drawMini(time: number) {
    const { ctx } = this;
    const top = this.miniTop;
    const span = this.w - PAD * 2;
    const mx = (t: number) => PAD + (t / this.dur) * span;
    for (const s of this.edit.segs) {
      ctx.fillStyle = s.on ? C.mini : C.miniOff;
      ctx.fillRect(
        mx(s.start),
        top,
        Math.max(1, mx(s.end) - mx(s.start) - 1),
        MINI
      );
    }
    if (!this.fitted) {
      const a = mx(this.vinv(this.scroll));
      const b = mx(this.vinv(this.scroll + this.visible));
      ctx.strokeStyle = "rgba(245,244,239,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(a - 0.5, top - 2.5, Math.max(4, b - a) + 1, MINI + 5, 3);
      ctx.stroke();
    }
    ctx.fillStyle = C.playhead;
    ctx.fillRect(mx(time) - 1, top - 2, 2, MINI + 4);
  }

  // ---- interaction

  private local(e: PointerEvent | WheelEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private laneAt(y: number) {
    // audio lanes scrolled out of their box can't be clicked through the video area
    const audioOk = this.inAudio(y);
    return this.lanes().find(
      l =>
        (l.kind !== "audio" || audioOk) &&
        y >= l.y - LANE_GAP / 2 &&
        y <= l.y + l.h + LANE_GAP / 2
    );
  }

  private fileSpan(t: Track): [number, number] {
    return [this.x(t.offset), this.x(t.offset + t.duration)];
  }

  /** Track whose volume line is under the mouse, if any. */
  private hoverGain() {
    if (this.hoverX < 0 || this.drag) return null;
    return this.gainHit(this.hoverX, this.hoverY);
  }

  private gainHit(x: number, y: number) {
    const lane = this.laneAt(y);
    if (lane?.kind !== "audio") return null;
    const t = lane.track;
    if (t.kind === "file") {
      const [a, b] = this.fileSpan(t);
      if (x < a || x > b) return null;
    }
    return Math.abs(y - this.volY(t, lane)) <= 5 ? t.id : null;
  }

  private hit(x: number, y: number): Drag {
    if (y < RULER - 10 || y > this.lanesBottom + 4) return null;
    const e = this.edit;
    if (e.inPt != null && Math.abs(x - this.x(e.inPt)) <= HIT)
      return { kind: "mark", which: "in" };
    if (e.outPt != null && Math.abs(x - this.x(e.outPt)) <= HIT)
      return { kind: "mark", which: "out" };
    if (y < TRACK_TOP) return null;
    const lane = this.laneAt(y);
    if (lane?.kind === "image") {
      const o = lane.overlay;
      const [a, b] = this.imageSpan(o);
      const from: [number, number] = [o.start, o.duration];
      if (Math.abs(x - b) <= HIT)
        return { kind: "trim", id: o.id, edge: "end", from };
      if (Math.abs(x - a) <= HIT)
        return { kind: "trim", id: o.id, edge: "start", from };
      if (x > a && x < b)
        return { kind: "move", id: o.id, grab: this.t(x), from: o.start };
      return null;
    }
    const gain = this.gainHit(x, y);
    if (gain) return { kind: "gain", id: gain, y, from: e.track(gain)!.gainDb };
    let best: Drag = null;
    let bestD = HIT + 1;
    e.segs.forEach((s, k) => {
      const d = Math.abs(x - this.x(s.start));
      if (k > 0 && d < bestD) {
        best = { kind: "cut", k };
        bestD = d;
      }
    });
    if (best) return best;
    if (lane?.kind === "audio" && lane.track.kind === "file") {
      const [a, b] = this.fileSpan(lane.track);
      if (x >= a && x <= b)
        return {
          kind: "move",
          id: lane.track.id,
          grab: this.t(x),
          from: lane.track.offset,
        };
    }
    return null;
  }

  private snapTargets() {
    return [
      ...this.edit.cuts(),
      this.edit.inPt,
      this.edit.outPt,
      0,
      this.dur,
      this.hooks.time(),
    ];
  }

  /** Snap to cuts, marks and the playhead when close, so it's easy to land exactly on them. */
  private snap(t: number, extra: (number | null)[] = []) {
    for (const c of [...this.snapTargets(), ...extra])
      if (c != null && Math.abs(this.x(c) - this.x(t)) <= 5) return c;
    return t;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);

    if (y >= this.miniTop - 5) {
      const tm = ((x - PAD) / (this.w - PAD * 2)) * this.dur;
      const vm = this.v(tm);
      const inside = vm >= this.scroll && vm <= this.scroll + this.visible;
      this.drag = {
        kind: "mini",
        offset: inside ? vm - this.scroll : this.visible / 2,
      };
      if (this.fitted) this.hooks.seek(this.clampT(tm));
      else this.onMove(e);
      return;
    }

    const bar = this.scrollbarRect();
    if (bar && x >= this.w - 12 && this.inAudio(y)) {
      // grabbing the thumb drags it; clicking the track jumps there
      if (y < bar.y || y > bar.y + bar.h)
        this.scrollAudio(
          ((y - this.audioTop - bar.h / 2) / (this.audioViewH - bar.h)) *
            this.maxV
        );
      this.drag = { kind: "vscroll", grab: y, from: this.vscroll };
      return;
    }

    const lane = this.laneAt(y);
    const hit = this.hit(x, y);
    if (hit) {
      this.edit.checkpoint();
      this.drag = hit;
      if (hit.kind === "gain" || hit.kind === "move" || hit.kind === "trim")
        this.edit.selectLane(
          hit.id,
          this.hooks.linkedSelection(),
          e.ctrlKey || e.metaKey
        );
      this.hooks.changed();
      return;
    }
    const t = this.clampT(this.t(x));
    if (y >= TRACK_TOP && lane) {
      this.edit.sel = this.edit.indexAt(t);
      this.edit.selectLane(
        laneId(lane),
        this.hooks.linkedSelection(),
        e.ctrlKey || e.metaKey
      );
      this.hooks.changed();
    }
    this.drag = { kind: "scrub" };
    this.hooks.seek(e.shiftKey ? t : this.snap(t));
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.local(e);
    this.hoverX = x;
    this.hoverY = y;
    this.invalidate();
    const d = this.drag;
    if (!d) {
      const hit = this.hit(x, y);
      this.canvas.style.cursor =
        hit?.kind === "gain"
          ? "ns-resize"
          : hit?.kind === "move"
            ? "grab"
            : hit?.kind === "trim"
              ? "ew-resize"
              : hit
                ? "col-resize"
                : "default";
      return;
    }
    const t = this.clampT(this.t(x));
    const e2 = this.edit;
    if (d.kind === "scrub") {
      this.hooks.seek(e.shiftKey ? t : this.snap(t));
    } else if (d.kind === "cut") {
      this.hooks.seek(e2.moveCut(d.k, t));
    } else if (d.kind === "mark") {
      const gap = e2.minLen;
      if (d.which === "in") e2.inPt = Math.min(t, (e2.outPt ?? this.dur) - gap);
      else e2.outPt = Math.max(t, (e2.inPt ?? 0) + gap);
      e2.onChange();
      this.hooks.seek(d.which === "in" ? e2.inPt! : e2.outPt!);
    } else if (d.kind === "gain") {
      const track = e2.track(d.id);
      if (!track) return;
      // relative drag so small moves make small changes; hold ctrl for extra fine control
      let db = d.from + (d.y - y) * (e.ctrlKey ? 0.05 : 0.25);
      db = Math.min(Math.max(db, DB_MIN), DB_MAX);
      if (Math.abs(db) < 0.4 && !e.shiftKey) db = 0;
      track.gainDb = Math.round(db * 10) / 10;
      e2.onChange();
    } else if (d.kind === "move") {
      const track = e2.track(d.id);
      const o = e2.overlay(d.id);
      const len = track?.duration ?? o?.duration ?? 0;
      let start = d.from + (this.t(x) - d.grab);
      if (!e.shiftKey) {
        // snap either end, whichever is close
        const snapped = this.snap(start);
        start = snapped !== start ? snapped : this.snap(start + len) - len;
      }
      start = Math.round(start * 1000) / 1000;
      if (track) track.offset = start;
      else if (o) o.start = Math.min(Math.max(start, 0), this.dur - 0.1);
      this.canvas.style.cursor = "grabbing";
      e2.onChange();
    } else if (d.kind === "trim") {
      const o = e2.overlay(d.id);
      if (!o) return;
      const [start, len] = d.from;
      const at = e.shiftKey ? t : this.snap(t);
      if (d.edge === "end") o.duration = Math.max(0.1, at - start);
      else {
        o.start = Math.min(at, start + len - 0.1);
        o.duration = start + len - o.start;
      }
      o.start = Math.round(o.start * 1000) / 1000;
      o.duration = Math.round(o.duration * 1000) / 1000;
      e2.onChange();
    } else if (d.kind === "mini") {
      const tm = ((x - PAD) / (this.w - PAD * 2)) * this.dur;
      if (this.fitted) this.hooks.seek(this.clampT(tm));
      else {
        this.scroll = this.v(tm) - d.offset;
        this.clampScroll();
      }
    } else if (d.kind === "vscroll") {
      const bar = this.scrollbarRect();
      if (bar)
        this.scrollAudio(
          d.from + ((y - d.grab) / (this.audioViewH - bar.h)) * this.maxV
        );
    }
  }

  private onUp() {
    this.drag = null;
    this.invalidate();
  }

  private onContext(e: MouseEvent) {
    e.preventDefault();
    const { x, y } = this.local(e);
    const t = this.clampT(this.t(x));
    const lane =
      y >= TRACK_TOP && y <= this.lanesBottom + 4 ? this.laneAt(y) : undefined;
    if (!lane) {
      this.hooks.menu({ t, area: y < RULER ? "ruler" : "empty" }, e);
      return;
    }
    const id = laneId(lane);
    let onClip = true;
    if (lane.kind === "image") {
      const [a, b] = this.imageSpan(lane.overlay);
      onClip = x >= a && x <= b;
    } else if (lane.kind === "audio" && lane.track.kind === "file") {
      const [a, b] = this.fileSpan(lane.track);
      onClip = x >= a && x <= b;
    }
    // like Resolve: right-clicking something selects it, unless it's already part of the selection
    if (onClip && lane.kind !== "image") this.edit.sel = this.edit.indexAt(t);
    if (!this.edit.isSelected(id))
      this.edit.selectLane(id, this.hooks.linkedSelection());
    this.hooks.changed();
    this.hooks.menu(
      {
        t,
        area: lane.kind,
        id: lane.kind === "video" ? undefined : id,
        onClip,
      },
      e
    );
  }

  /** Double-clicking a volume line resets it to 0 dB. */
  private onDouble(e: MouseEvent) {
    const { x, y } = this.local(e);
    const id = this.gainHit(x, y);
    if (id) this.edit.updateTrack(id, { gainDb: 0 });
  }

  /**
   * Ctrl + wheel zooms. Plain wheel scrolls the audio tracks when over them (or their headers),
   * and pans the timeline sideways over the ruler and video. Shift + wheel always pans.
   */
  private onWheel(e: WheelEvent, onHeaders = false) {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.hgt : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const { x, y } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      if (!onHeaders) this.zoomAt(x, Math.exp(-dy * 0.0018));
      return;
    }
    const sideways = e.shiftKey || Math.abs(dx) > Math.abs(dy);
    if (!sideways && this.inAudio(y) && this.maxV > 0) {
      this.scrollAudio(this.vscroll + dy);
      return;
    }
    if (onHeaders) return;
    this.scroll += (sideways ? dx || dy : dy) / this.zoom;
    this.clampScroll();
    this.dirty = true;
  }
}
