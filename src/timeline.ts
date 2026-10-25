import type { Edit } from "./edit";
import { fmt } from "./ui";

const PAD = 14;
const RULER = 26;
const TRACK_TOP = RULER + 6;
const FILM = 56;
const WAVE = 38;
const TRACK_H = FILM + WAVE;
const MINI_TOP = TRACK_TOP + TRACK_H + 12;
const MINI = 6;
export const TIMELINE_HEIGHT = MINI_TOP + MINI + 10;
const MAX_ZOOM = 900; // px per second
const HIT = 6;

const C = {
  clip: "#3a3935",
  clipOff: "#2a2927",
  border: "rgba(222,220,209,0.13)",
  selected: "#ecebe4",
  wave: "#a3a197",
  waveOff: "#55534e",
  dim: "rgba(31,30,29,0.6)",
  hatch: "rgba(222,220,209,0.08)",
  tick: "rgba(222,220,209,0.2)",
  label: "#8a887f",
  range: "rgba(59,142,234,0.15)",
  rangeEdge: "#3b8eea",
  playhead: "#d97757",
  hover: "rgba(245,244,239,0.28)",
  pill: "#3a3935",
  pillText: "#ecebe4",
  mini: "#5d5b55",
  miniOff: "#34332f",
};

type Drag =
  | { kind: "scrub" }
  | { kind: "cut"; k: number }
  | { kind: "mark"; which: "in" | "out" }
  | { kind: "mini"; offset: number }
  | null;

type Hooks = {
  time: () => number;
  seek: (t: number) => void;
  select: (i: number) => void;
};

export class Timeline {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private w = 0;
  private dpr = 1;
  private fitted = true;
  private hoverX = -1;
  private hoverY = -1;
  private drag: Drag = null;
  private dirty = true;
  private lastTime = -1;
  private ro: ResizeObserver;
  zoom = 1;
  scroll = 0;
  thumbs: (HTMLCanvasElement | undefined)[] = [];
  thumbStep = 1;
  peaks: Uint8Array | null = null;

  constructor(
    host: HTMLElement,
    private edit: Edit,
    public aspect: number,
    private hooks: Hooks,
  ) {
    this.canvas.className = "timeline-canvas";
    host.style.height = `${TIMELINE_HEIGHT}px`;
    host.append(this.canvas);
    this.ro = new ResizeObserver(() => this.resize(host.clientWidth));
    this.ro.observe(host);
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", () => this.onUp());
    this.canvas.addEventListener("pointercancel", () => this.onUp());
    this.canvas.addEventListener("pointerleave", () => {
      this.hoverX = -1;
      this.invalidate();
    });
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }

  invalidate() {
    this.dirty = true;
  }

  private get dur() {
    return this.edit.duration;
  }

  private x(t: number) {
    return PAD + (t - this.scroll) * this.zoom;
  }

  private t(x: number) {
    return this.scroll + (x - PAD) / this.zoom;
  }

  private clampT(t: number) {
    return Math.min(Math.max(t, 0), this.dur);
  }

  private get visible() {
    return (this.w - PAD * 2) / this.zoom;
  }

  private fitZoom() {
    return Math.max(1e-3, (this.w - PAD * 2) / this.dur);
  }

  private resize(w: number) {
    if (w === this.w && devicePixelRatio === this.dpr) return;
    this.w = w;
    this.dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(TIMELINE_HEIGHT * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${TIMELINE_HEIGHT}px`;
    if (this.fitted) this.zoom = this.fitZoom();
    this.zoom = Math.max(this.zoom, this.fitZoom());
    this.clampScroll();
    this.dirty = true;
    this.render();
  }

  private clampScroll() {
    this.scroll = Math.min(Math.max(this.scroll, 0), Math.max(0, this.dur - this.visible));
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
    this.scroll = t - (x - PAD) / this.zoom;
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
      this.scroll = t - this.visible * 0.08;
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
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, TIMELINE_HEIGHT);
    ctx.font = "11px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
    ctx.textBaseline = "middle";

    this.drawRuler();
    this.drawClips();
    this.drawRange();
    this.drawHover();
    this.drawPlayhead(time);
    this.drawMini(time);
  }

  private drawRuler() {
    const { ctx } = this;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const step = steps.find((s) => s * this.zoom >= 84) ?? 3600;
    const minor = step / 5;
    const showMinor = minor * this.zoom >= 7;
    const end = this.clampT(this.t(this.w));
    const first = Math.floor(this.clampT(this.t(0)) / minor) * minor;
    for (let i = 0; ; i++) {
      const t = first + i * minor;
      if (t > end + 1e-9) break;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      if (!major && !showMinor) continue;
      const x = Math.round(this.x(t)) + 0.5;
      ctx.fillStyle = C.tick;
      ctx.fillRect(x - 0.5, major ? RULER - 9 : RULER - 5, 1, major ? 9 : 5);
      if (major) {
        ctx.fillStyle = C.label;
        ctx.fillText(step < 1 ? fmt(t).replace(/(\.\d)\d$/, "$1") : fmt(t, false), x + 4, 10);
      }
    }
  }

  private drawClips() {
    const { ctx } = this;
    const segs = this.edit.segs;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let x0 = this.x(s.start) + (i > 0 ? 1 : 0);
      let x1 = this.x(s.end) - (i < segs.length - 1 ? 1 : 0);
      if (x1 < 0 || x0 > this.w) continue;
      if (x1 - x0 < 2) x1 = x0 + 2;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, TRACK_TOP, x1 - x0, TRACK_H, 6);
      ctx.clip();
      ctx.fillStyle = s.on ? C.clip : C.clipOff;
      ctx.fillRect(x0, TRACK_TOP, x1 - x0, TRACK_H);
      if (!s.on) {
        ctx.filter = "grayscale(1)";
        ctx.globalAlpha = 0.45;
      }
      this.drawThumbs(x0, x1);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(x0, TRACK_TOP + FILM, x1 - x0, 1);
      this.drawWave(x0, x1, s.on);
      if (!s.on) {
        ctx.fillStyle = C.dim;
        ctx.fillRect(x0, TRACK_TOP, x1 - x0, TRACK_H);
        ctx.strokeStyle = C.hatch;
        ctx.lineWidth = 6;
        ctx.beginPath();
        for (let hx = x0 - TRACK_H - ((x0 + this.scroll * this.zoom) % 16); hx < x1; hx += 16) {
          ctx.moveTo(hx, TRACK_TOP + TRACK_H);
          ctx.lineTo(hx + TRACK_H, TRACK_TOP);
        }
        ctx.stroke();
      }
      ctx.restore();

      const sel = i === this.edit.sel;
      ctx.beginPath();
      ctx.roundRect(x0 + 0.5, TRACK_TOP + 0.5, x1 - x0 - 1, TRACK_H - 1, 6);
      ctx.strokeStyle = sel ? C.selected : C.border;
      ctx.lineWidth = sel ? 2 : 1;
      ctx.stroke();
    }
  }

  private thumbAt(t: number) {
    const n = this.thumbs.length;
    const i = Math.min(Math.max(Math.round(t / this.thumbStep), 0), n - 1);
    for (let d = 0; d < n; d++) {
      const img = this.thumbs[i - d] ?? this.thumbs[i + d];
      if (img) return img;
    }
    return undefined;
  }

  private drawThumbs(x0: number, x1: number) {
    if (!this.thumbs.length) return;
    const tw = FILM * this.aspect;
    const origin = this.x(0);
    const end = this.x(this.dur);
    for (let k = Math.max(0, Math.floor((x0 - origin) / tw)); ; k++) {
      const sx = origin + k * tw;
      if (sx > x1 || sx > end) break;
      const img = this.thumbAt(Math.min((sx + tw / 2 - origin) / this.zoom, this.dur));
      if (img) this.ctx.drawImage(img, sx, TRACK_TOP, tw, FILM);
    }
  }

  private drawWave(x0: number, x1: number, on: boolean) {
    const peaks = this.peaks;
    if (!peaks?.length) return;
    const { ctx } = this;
    const mid = TRACK_TOP + FILM + WAVE / 2;
    const amp = WAVE / 2 - 4;
    ctx.fillStyle = on ? C.wave : C.waveOff;
    ctx.beginPath();
    const from = Math.max(Math.floor(x0), 0);
    const to = Math.min(x1, this.w);
    for (let px = from; px < to; px += 2) {
      const i0 = Math.max(0, Math.floor(this.t(px) * 100));
      const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(this.t(px + 2) * 100)));
      let m = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
      const hh = Math.max(0.6, (m / 255) * amp);
      ctx.rect(px, mid - hh, 1.3, hh * 2);
    }
    ctx.fill();
  }

  private drawRange() {
    const r = this.edit.range();
    if (!r) return;
    const { ctx } = this;
    const a = this.x(r[0]);
    const b = this.x(r[1]);
    ctx.fillStyle = C.range;
    ctx.fillRect(a, TRACK_TOP, b - a, TRACK_H);
    ctx.fillStyle = C.rangeEdge;
    ctx.fillRect(a, RULER - 3, b - a, 3);
    const edge = (x: number, dir: 1 | -1) => {
      ctx.fillRect(x - (dir === 1 ? 0 : 2), RULER - 8, 2, TRACK_H + TRACK_TOP - RULER + 10);
      ctx.fillRect(x - (dir === 1 ? 0 : 7), RULER - 8, 7, 2);
      ctx.fillRect(x - (dir === 1 ? 0 : 7), TRACK_TOP + TRACK_H, 7, 2);
    };
    if (this.edit.inPt != null) edge(a, 1);
    if (this.edit.outPt != null) edge(b, -1);
  }

  private drawHover() {
    if (this.hoverX < 0 || this.drag || this.hoverY > MINI_TOP - 4) return;
    const { ctx } = this;
    const x = Math.round(this.hoverX) + 0.5;
    ctx.fillStyle = C.hover;
    ctx.fillRect(x - 0.5, RULER, 1, TRACK_TOP + TRACK_H - RULER);
    const label = fmt(this.clampT(this.t(this.hoverX)));
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
    ctx.fillRect(x - 1, 8, 2, TRACK_TOP + TRACK_H - 6);
    ctx.beginPath();
    ctx.roundRect(x - 6, 3, 12, 14, 3);
    ctx.fill();
  }

  private drawMini(time: number) {
    const { ctx } = this;
    const span = this.w - PAD * 2;
    const mx = (t: number) => PAD + (t / this.dur) * span;
    for (const s of this.edit.segs) {
      ctx.fillStyle = s.on ? C.mini : C.miniOff;
      ctx.fillRect(mx(s.start), MINI_TOP, Math.max(1, mx(s.end) - mx(s.start) - 1), MINI);
    }
    if (!this.fitted) {
      const a = mx(this.scroll);
      const b = mx(Math.min(this.dur, this.scroll + this.visible));
      ctx.strokeStyle = "rgba(245,244,239,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(a - 0.5, MINI_TOP - 2.5, Math.max(4, b - a) + 1, MINI + 5, 3);
      ctx.stroke();
    }
    ctx.fillStyle = C.playhead;
    ctx.fillRect(mx(time) - 1, MINI_TOP - 2, 2, MINI + 4);
  }

  // ---- interaction

  private local(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number): Drag {
    if (y < RULER - 10 || y > TRACK_TOP + TRACK_H + 4) return null;
    const e = this.edit;
    if (e.inPt != null && Math.abs(x - this.x(e.inPt)) <= HIT) return { kind: "mark", which: "in" };
    if (e.outPt != null && Math.abs(x - this.x(e.outPt)) <= HIT) return { kind: "mark", which: "out" };
    if (y < TRACK_TOP) return null;
    let best: Drag = null;
    let bestD = HIT + 1;
    e.segs.forEach((s, k) => {
      const d = Math.abs(x - this.x(s.start));
      if (k > 0 && d < bestD) {
        best = { kind: "cut", k };
        bestD = d;
      }
    });
    return best;
  }

  /** Snap scrubbing to cuts and marks when close, so it's easy to land exactly on them. */
  private snap(t: number) {
    const targets = [...this.edit.cuts(), this.edit.inPt, this.edit.outPt, 0, this.dur];
    for (const c of targets) if (c != null && Math.abs(this.x(c) - this.x(t)) <= 5) return c;
    return t;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);

    if (y >= MINI_TOP - 5) {
      const tm = ((x - PAD) / (this.w - PAD * 2)) * this.dur;
      const inside = tm >= this.scroll && tm <= this.scroll + this.visible;
      this.drag = { kind: "mini", offset: inside ? tm - this.scroll : this.visible / 2 };
      if (this.fitted) this.hooks.seek(this.clampT(tm));
      else this.onMove(e);
      return;
    }

    const hit = this.hit(x, y);
    if (hit) {
      this.edit.checkpoint();
      this.drag = hit;
      return;
    }
    const t = this.clampT(this.t(x));
    if (y >= TRACK_TOP) this.hooks.select(this.edit.indexAt(t));
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
      const h = this.hit(x, y);
      this.canvas.style.cursor = h ? "col-resize" : "default";
      return;
    }
    const t = this.clampT(this.t(x));
    if (d.kind === "scrub") {
      this.hooks.seek(e.shiftKey ? t : this.snap(t));
    } else if (d.kind === "cut") {
      this.hooks.seek(this.edit.moveCut(d.k, t));
    } else if (d.kind === "mark") {
      const e2 = this.edit;
      const gap = e2.minLen;
      if (d.which === "in") e2.inPt = Math.min(t, (e2.outPt ?? this.dur) - gap);
      else e2.outPt = Math.max(t, (e2.inPt ?? 0) + gap);
      e2.onChange();
      this.hooks.seek(d.which === "in" ? e2.inPt! : e2.outPt!);
    } else if (d.kind === "mini") {
      const tm = ((x - PAD) / (this.w - PAD * 2)) * this.dur;
      if (this.fitted) this.hooks.seek(this.clampT(tm));
      else {
        this.scroll = tm - d.offset;
        this.clampScroll();
      }
    }
  }

  private onUp() {
    this.drag = null;
    this.invalidate();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const { x } = this.local(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scroll += (e.deltaX || e.deltaY) / this.zoom;
      this.clampScroll();
      this.dirty = true;
    } else {
      this.zoomAt(x, Math.exp(-e.deltaY * 0.0018));
    }
  }
}
