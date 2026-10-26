import type { MetaEdit } from "../api";
import { store } from "../settings";
import { h } from "../ui";
import {
  blobToDataUrl,
  cloneDoc,
  drawBg,
  drawLayer,
  fitText,
  hitLayer,
  loadPicture,
  newId,
  newLayer,
  rad,
  toLocal,
  toWorld,
  type Doc,
  type Layer,
} from "./doc";

export type Tool =
  | "select"
  | "rect"
  | "ellipse"
  | "triangle"
  | "line"
  | "arrow"
  | "pen"
  | "text";

export const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  r: "rect",
  o: "ellipse",
  y: "triangle",
  l: "line",
  a: "arrow",
  p: "pen",
  t: "text",
};

type Handle = { hx: number; hy: number };

type Drag =
  | { type: "pan"; sx: number; sy: number; ox: number; oy: number }
  | {
      type: "move";
      sx: number;
      sy: number;
      orig: Map<string, { x: number; y: number }>;
      moved: boolean;
    }
  | { type: "resize"; handle: Handle; orig: Layer; keep: boolean }
  | { type: "rotate"; orig: Layer }
  | { type: "create"; tool: Tool; sx: number; sy: number; id: string }
  | { type: "pen"; pts: number[] };

type Snap = Pick<Doc, "w" | "h" | "bg" | "layers" | "meta">;

const HANDLES: Handle[] = [
  { hx: -1, hy: -1 },
  { hx: 0, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 1 },
  { hx: -1, hy: 0 },
];

const ROTATE_GAP = 26;
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

/** The canvas, tools, selection and undo history of one open picture. */
export class ImageEditor {
  doc: Doc;
  sel: string[] = [];
  tool: Tool = "select";
  readonly el: HTMLElement;
  /** called after anything the panels show has changed */
  onChange: () => void = () => {};
  onTool: () => void = () => {};

  private canvas = h("canvas", { class: "ie-canvas" });
  private ctx = this.canvas.getContext("2d")!;
  private view = { zoom: 1, x: 0, y: 0 };
  private dpr = 1;
  private frame = 0;
  private drag: Drag | null = null;
  private guides: { x?: number; y?: number } = {};
  private spaceDown = false;
  private history: Snap[] = [];
  private at = 0;
  private savedAt = 0;
  private fitted = false;
  private editor: HTMLTextAreaElement | null = null;
  private clip: Layer[] = [];
  private watch: ResizeObserver;

  constructor(doc: Doc) {
    this.doc = doc;
    this.history = [this.snap()];
    this.el = h("div", { class: "ie-view" }, this.canvas);
    this.watch = new ResizeObserver(() => this.resize());
    this.watch.observe(this.el);
    const c = this.canvas;
    c.addEventListener("pointerdown", e => this.down(e));
    c.addEventListener("pointermove", e => this.move(e));
    c.addEventListener("pointerup", e => this.up(e));
    c.addEventListener("pointercancel", e => this.up(e));
    c.addEventListener("dblclick", e => this.doubleClick(e));
    c.addEventListener("wheel", e => this.wheel(e), { passive: false });
    window.addEventListener("keyup", this.keyUp);
  }

  destroy() {
    this.watch.disconnect();
    cancelAnimationFrame(this.frame);
    window.removeEventListener("keyup", this.keyUp);
  }

  // ---- history

  private snap(): Snap {
    return structuredClone({
      w: this.doc.w,
      h: this.doc.h,
      bg: this.doc.bg,
      layers: this.doc.layers,
      meta: this.doc.meta,
    });
  }

  private restore(s: Snap) {
    const c = structuredClone(s);
    this.doc = { w: c.w, h: c.h, bg: c.bg, layers: c.layers, meta: c.meta };
    this.sel = this.sel.filter(id => this.doc.layers.some(l => l.id === id));
  }

  /** Call after a finished change; this is what undo steps back to. */
  commit() {
    this.history = this.history.slice(0, this.at + 1);
    this.history.push(this.snap());
    if (this.history.length > 100) this.history.shift();
    this.at = this.history.length - 1;
    if (this.savedAt > this.at) this.savedAt = -1;
    this.changed();
  }

  undo() {
    if (this.at === 0) return;
    this.restore(this.history[--this.at]);
    this.changed();
  }

  redo() {
    if (this.at >= this.history.length - 1) return;
    this.restore(this.history[++this.at]);
    this.changed();
  }

  get canUndo() {
    return this.at > 0;
  }
  get canRedo() {
    return this.at < this.history.length - 1;
  }
  get dirty() {
    return this.at !== this.savedAt;
  }
  markSaved() {
    this.savedAt = this.at;
  }

  private changed() {
    this.draw();
    this.onChange();
  }

  // ---- metadata: the same shape the video editor gives the metadata dialog

  get meta() {
    return (this.doc.meta ??= { tags: {}, strip: false });
  }

  setTags(patch: Record<string, string | null | undefined>) {
    const tags = { ...this.meta.tags };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete tags[k];
      else tags[k] = v;
    }
    this.doc.meta = { ...this.meta, tags };
    this.commit();
  }

  setStrip(strip: boolean) {
    this.doc.meta = { ...this.meta, strip };
    this.commit();
  }

  clearTags() {
    this.doc.meta = { ...this.meta, tags: {} };
    this.commit();
  }

  metaEdit(): MetaEdit {
    return { strip: this.meta.strip, tags: Object.entries(this.meta.tags) };
  }

  // ---- layers

  layer(id: string) {
    return this.doc.layers.find(l => l.id === id);
  }

  get selected() {
    return this.doc.layers.filter(l => this.sel.includes(l.id));
  }

  select(ids: string[]) {
    this.sel = ids;
    this.changed();
  }

  add(l: Layer, select = true) {
    this.doc.layers.push(l);
    if (select) this.sel = [l.id];
    this.commit();
  }

  /** Change layers without adding an undo step (finish with commit() when done). */
  set(ids: string[], patch: Partial<Layer>) {
    for (const l of this.doc.layers)
      if (ids.includes(l.id)) {
        Object.assign(l, patch);
        if (
          l.kind === "text" &&
          ("text" in patch ||
            "size" in patch ||
            "font" in patch ||
            "bold" in patch)
        )
          fitText(l);
      }
    this.changed();
  }

  setDoc(patch: Partial<Pick<Doc, "w" | "h" | "bg">>) {
    Object.assign(this.doc, patch);
    this.changed();
  }

  remove(ids = this.sel) {
    if (!ids.length) return;
    this.doc.layers = this.doc.layers.filter(l => !ids.includes(l.id));
    this.sel = this.sel.filter(id => !ids.includes(id));
    this.commit();
  }

  duplicate(ids = this.sel) {
    const copies = this.doc.layers
      .filter(l => ids.includes(l.id))
      .map(l => ({
        ...structuredClone(l),
        id: newId(),
        x: l.x + 24,
        y: l.y + 24,
      }));
    if (!copies.length) return;
    this.doc.layers.push(...copies);
    this.sel = copies.map(l => l.id);
    this.commit();
  }

  /** Move layers up (1) or down (-1) one step, or all the way with Infinity. */
  restack(ids: string[], by: number) {
    const ls = this.doc.layers;
    const picked = ls.filter(l => ids.includes(l.id));
    if (!picked.length) return;
    if (!isFinite(by)) {
      const rest = ls.filter(l => !ids.includes(l.id));
      this.doc.layers = by > 0 ? [...rest, ...picked] : [...picked, ...rest];
    } else {
      const order = by > 0 ? [...picked].reverse() : picked;
      for (const l of order) {
        const i = ls.indexOf(l);
        const j = clamp(i + by, 0, ls.length - 1);
        if (ids.includes(ls[j].id)) continue;
        ls.splice(i, 1);
        ls.splice(j, 0, l);
      }
    }
    this.commit();
  }

  align(how: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") {
    for (const l of this.selected) {
      const [bx0, by0, bx1, by1] = this.bounds(l);
      if (how === "left") l.x += -bx0;
      if (how === "right") l.x += this.doc.w - bx1;
      if (how === "hcenter") l.x += this.doc.w / 2 - (bx0 + bx1) / 2;
      if (how === "top") l.y += -by0;
      if (how === "bottom") l.y += this.doc.h - by1;
      if (how === "vcenter") l.y += this.doc.h / 2 - (by0 + by1) / 2;
    }
    this.commit();
  }

  /** Axis-aligned box around a layer after rotation. */
  private bounds(l: Layer): [number, number, number, number] {
    const pts = [
      toWorld(l, -l.w / 2, -l.h / 2),
      toWorld(l, l.w / 2, -l.h / 2),
      toWorld(l, l.w / 2, l.h / 2),
      toWorld(l, -l.w / 2, l.h / 2),
    ];
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  copy() {
    this.clip = structuredClone(this.selected);
    return this.clip.length > 0;
  }

  pasteLayers() {
    if (!this.clip.length) return false;
    const copies = this.clip.map(l => ({ ...structuredClone(l), id: newId() }));
    this.clip = this.clip.map(l => ({ ...l, x: l.x + 24, y: l.y + 24 }));
    this.doc.layers.push(...copies);
    this.sel = copies.map(l => l.id);
    this.commit();
    return true;
  }

  /** Put a picture on the canvas, shrunk to fit if it's bigger than the canvas. */
  async addPicture(src: string, name = "Image", at?: [number, number]) {
    const img = await loadPicture(src);
    const fit = Math.min(
      1,
      (this.doc.w * 0.9) / img.naturalWidth,
      (this.doc.h * 0.9) / img.naturalHeight
    );
    const l = newLayer("image", {
      name,
      src,
      w: Math.round(img.naturalWidth * fit),
      h: Math.round(img.naturalHeight * fit),
      x: at?.[0] ?? this.doc.w / 2,
      y: at?.[1] ?? this.doc.h / 2,
    });
    this.add(l);
  }

  async addBlob(blob: Blob, name?: string) {
    await this.addPicture(await blobToDataUrl(blob), name);
  }

  // ---- view

  private resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    if (!this.fitted) {
      this.fitted = true;
      this.fit();
    } else this.draw();
  }

  fit() {
    const r = this.el.getBoundingClientRect();
    const pad = 48;
    const z = Math.min(
      (r.width - pad * 2) / this.doc.w,
      (r.height - pad * 2) / this.doc.h
    );
    this.view.zoom = clamp(z, 0.02, 8);
    this.view.x = (r.width - this.doc.w * this.view.zoom) / 2;
    this.view.y = (r.height - this.doc.h * this.view.zoom) / 2;
    this.draw();
    this.onChange();
  }

  zoomTo(zoom: number, cx?: number, cy?: number) {
    const r = this.el.getBoundingClientRect();
    cx ??= r.width / 2;
    cy ??= r.height / 2;
    const z = clamp(zoom, 0.02, 16);
    const wx = (cx - this.view.x) / this.view.zoom;
    const wy = (cy - this.view.y) / this.view.zoom;
    this.view.zoom = z;
    this.view.x = cx - wx * z;
    this.view.y = cy - wy * z;
    this.draw();
    this.onChange();
  }

  get zoom() {
    return this.view.zoom;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      this.zoomTo(
        this.view.zoom * Math.exp(-e.deltaY * 0.0015),
        e.clientX - r.left,
        e.clientY - r.top
      );
      return;
    }
    if (e.shiftKey) this.view.x -= e.deltaY;
    else {
      this.view.x -= e.deltaX;
      this.view.y -= e.deltaY;
    }
    this.draw();
  }

  private world(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left - this.view.x) / this.view.zoom,
      (e.clientY - r.top - this.view.y) / this.view.zoom,
    ];
  }

  // ---- drawing

  draw() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  }

  private paint() {
    const { ctx, view, dpr, doc } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(
      view.zoom * dpr,
      0,
      0,
      view.zoom * dpr,
      view.x * dpr,
      view.y * dpr
    );

    // checkerboard under the picture so transparent parts are visible
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, doc.w, doc.h);
    ctx.clip();
    const cell = 16 / Math.max(view.zoom, 0.25);
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(0, 0, doc.w, doc.h);
    ctx.fillStyle = "#4a4a4a";
    for (let y = 0; y < doc.h; y += cell)
      for (let x = (Math.floor(y / cell) % 2) * cell; x < doc.w; x += cell * 2)
        ctx.fillRect(x, y, cell, cell);
    drawBg(ctx, doc);
    for (const l of doc.layers) drawLayer(ctx, l, () => this.draw());
    if (this.drag?.type === "pen") this.paintPen(this.drag.pts);
    ctx.restore();

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1 / view.zoom;
    ctx.strokeRect(0, 0, doc.w, doc.h);

    // everything below is drawn in screen pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintGuides();
    this.paintSelection();
  }

  private paintPen(pts: number[]) {
    const { ctx } = this;
    const p = store.settings.images;
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = Math.max(1, p.strokeWidth || 6);
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2)
      i ? ctx.lineTo(pts[i], pts[i + 1]) : ctx.moveTo(pts[i], pts[i + 1]);
    ctx.stroke();
  }

  private paintGuides() {
    const { ctx, view, doc } = this;
    ctx.strokeStyle = "#ff4d8d";
    ctx.lineWidth = 1;
    const r = this.el.getBoundingClientRect();
    if (this.guides.x != null) {
      const x = Math.round(view.x + this.guides.x * view.zoom) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, view.y - 8);
      ctx.lineTo(x, view.y + doc.h * view.zoom + 8);
      ctx.stroke();
    }
    if (this.guides.y != null) {
      const y = Math.round(view.y + this.guides.y * view.zoom) + 0.5;
      ctx.beginPath();
      ctx.moveTo(view.x - 8, y);
      ctx.lineTo(Math.min(r.width, view.x + doc.w * view.zoom + 8), y);
      ctx.stroke();
    }
  }

  private screen(wx: number, wy: number): [number, number] {
    return [
      this.view.x + wx * this.view.zoom,
      this.view.y + wy * this.view.zoom,
    ];
  }

  private corners(l: Layer) {
    return [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => this.screen(...toWorld(l, (a * l.w) / 2, (b * l.h) / 2)));
  }

  private handlePoint(l: Layer, hd: Handle) {
    return this.screen(...toWorld(l, (hd.hx * l.w) / 2, (hd.hy * l.h) / 2));
  }

  private rotatePoint(l: Layer) {
    return this.screen(
      ...toWorld(l, 0, -l.h / 2 - ROTATE_GAP / this.view.zoom)
    );
  }

  private paintSelection() {
    const { ctx } = this;
    ctx.strokeStyle = "#4c8dff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    for (const l of this.selected) {
      const c = this.corners(l);
      ctx.beginPath();
      c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
    const one = this.selected.length === 1 ? this.selected[0] : null;
    if (!one || one.locked) return;
    const [tx, ty] = this.handlePoint(one, { hx: 0, hy: -1 });
    const [rx, ry] = this.rotatePoint(one);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rx, ry, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const hd of HANDLES) {
      const [x, y] = this.handlePoint(one, hd);
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4, y - 4, 8, 8);
    }
  }

  // ---- pointer

  private screenPoint(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private pickHandle(sx: number, sy: number): Drag | null {
    const one = this.selected.length === 1 ? this.selected[0] : null;
    if (!one || one.locked) return null;
    const [rx, ry] = this.rotatePoint(one);
    if (Math.hypot(sx - rx, sy - ry) <= 9)
      return { type: "rotate", orig: { ...one } };
    for (const hd of HANDLES) {
      const [x, y] = this.handlePoint(one, hd);
      if (Math.abs(sx - x) <= 7 && Math.abs(sy - y) <= 7)
        return { type: "resize", handle: hd, orig: { ...one }, keep: false };
    }
    return null;
  }

  private topAt(wx: number, wy: number) {
    const tol = 4 / this.view.zoom;
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i];
      if (!l.locked && hitLayer(l, wx, wy, tol)) return l;
    }
    return null;
  }

  private down(e: PointerEvent) {
    this.commitText();
    const [sx, sy] = this.screenPoint(e);
    const [wx, wy] = this.world(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || this.spaceDown) {
      this.drag = { type: "pan", sx, sy, ox: this.view.x, oy: this.view.y };
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === "select") {
      const handle = this.pickHandle(sx, sy);
      if (handle) {
        if (handle.type === "resize")
          handle.keep = e.shiftKey || handle.orig.kind === "image";
        this.drag = handle;
        return;
      }
      const hit = this.topAt(wx, wy);
      if (!hit) {
        if (this.sel.length) this.select([]);
        return;
      }
      if (e.shiftKey)
        this.select(
          this.sel.includes(hit.id)
            ? this.sel.filter(id => id !== hit.id)
            : [...this.sel, hit.id]
        );
      else if (!this.sel.includes(hit.id)) this.select([hit.id]);
      this.drag = {
        type: "move",
        sx: wx,
        sy: wy,
        orig: new Map(this.selected.map(l => [l.id, { x: l.x, y: l.y }])),
        moved: false,
      };
      return;
    }

    if (this.tool === "text") {
      const l = newLayer("text", {
        x: wx,
        y: wy,
        text: "Text",
        fill: store.settings.images.stroke,
        size: Math.round(this.doc.h / 14),
      });
      fitText(l);
      l.x = wx + l.w / 2;
      l.y = wy + l.h / 2;
      this.add(l);
      this.setTool("select");
      this.editText(l.id, true);
      return;
    }

    if (this.tool === "pen") {
      this.drag = { type: "pen", pts: [wx, wy] };
      return;
    }

    const p = store.settings.images;
    const line = this.tool === "line" || this.tool === "arrow";
    const l = newLayer(this.tool as Layer["kind"], {
      x: wx,
      y: wy,
      w: 0,
      h: 0,
      fill: line ? null : p.fill,
      stroke: line ? p.stroke : p.strokeWidth ? p.stroke : null,
      sw: line ? Math.max(4, p.strokeWidth) : p.strokeWidth,
      radius: this.tool === "rect" ? 0 : 0,
    });
    this.doc.layers.push(l);
    this.sel = [l.id];
    this.drag = { type: "create", tool: this.tool, sx: wx, sy: wy, id: l.id };
    this.changed();
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) {
      this.cursor(e);
      return;
    }
    const [sx, sy] = this.screenPoint(e);
    const [wx, wy] = this.world(e);
    if (d.type === "pan") {
      this.view.x = d.ox + sx - d.sx;
      this.view.y = d.oy + sy - d.sy;
      this.draw();
    } else if (d.type === "move") this.dragMove(d, wx, wy, e.shiftKey);
    else if (d.type === "resize") this.dragResize(d, wx, wy, e.shiftKey);
    else if (d.type === "rotate") {
      const l = this.layer(d.orig.id);
      if (!l) return;
      let a = (Math.atan2(wy - l.y, wx - l.x) * 180) / Math.PI + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      l.rot = Math.round(a * 10) / 10;
      this.changed();
    } else if (d.type === "create") this.dragCreate(d, wx, wy, e.shiftKey);
    else if (d.type === "pen") {
      const n = d.pts.length;
      if (
        Math.hypot(wx - d.pts[n - 2], wy - d.pts[n - 1]) * this.view.zoom >
        2
      ) {
        d.pts.push(wx, wy);
        this.draw();
      }
    }
  }

  private dragMove(
    d: Extract<Drag, { type: "move" }>,
    wx: number,
    wy: number,
    shift: boolean
  ) {
    let dx = wx - d.sx;
    let dy = wy - d.sy;
    if (!d.moved && Math.hypot(dx, dy) * this.view.zoom < 3) return;
    d.moved = true;
    if (shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    this.guides = {};
    const ls = this.selected;
    if (store.settings.images.snap && !shift) {
      // snap the group's box (its edges and middle) to the canvas edges and middle
      const boxes = ls.map(l => {
        const o = d.orig.get(l.id)!;
        const b = this.bounds({ ...l, x: o.x, y: o.y });
        return b;
      });
      const x0 = Math.min(...boxes.map(b => b[0])) + dx;
      const x1 = Math.max(...boxes.map(b => b[2])) + dx;
      const y0 = Math.min(...boxes.map(b => b[1])) + dy;
      const y1 = Math.max(...boxes.map(b => b[3])) + dy;
      const tol = 6 / this.view.zoom;
      const near = (vals: number[], targets: number[]) => {
        let best: { off: number; at: number } | null = null;
        for (const v of vals)
          for (const t of targets)
            if (
              Math.abs(t - v) <= tol &&
              (!best || Math.abs(t - v) < Math.abs(best.off))
            )
              best = { off: t - v, at: t };
        return best;
      };
      const sxs = near(
        [x0, (x0 + x1) / 2, x1],
        [0, this.doc.w / 2, this.doc.w]
      );
      const sys = near(
        [y0, (y0 + y1) / 2, y1],
        [0, this.doc.h / 2, this.doc.h]
      );
      if (sxs) {
        dx += sxs.off;
        this.guides.x = sxs.at;
      }
      if (sys) {
        dy += sys.off;
        this.guides.y = sys.at;
      }
    }
    for (const l of ls) {
      const o = d.orig.get(l.id)!;
      l.x = o.x + dx;
      l.y = o.y + dy;
    }
    this.changed();
  }

  private dragResize(
    d: Extract<Drag, { type: "resize" }>,
    wx: number,
    wy: number,
    shift: boolean
  ) {
    const l = this.layer(d.orig.id);
    if (!l) return;
    const o = d.orig;
    const { hx, hy } = d.handle;
    const [px, py] = toLocal(o, wx, wy);
    let w = o.w;
    let hgt = o.h;
    let cx = 0;
    let cy = 0;
    if (hx) {
      const anchor = (-hx * o.w) / 2;
      w = Math.max(4, Math.abs(px - anchor));
      cx = (anchor + (anchor + hx * w)) / 2;
    }
    if (hy) {
      const anchor = (-hy * o.h) / 2;
      hgt = Math.max(4, Math.abs(py - anchor));
      cy = (anchor + (anchor + hy * hgt)) / 2;
    }
    if ((d.keep || shift) && hx && hy) {
      const k = Math.max(w / o.w, hgt / o.h);
      w = o.w * k;
      hgt = o.h * k;
      cx = (-hx * o.w) / 2 + (hx * w) / 2;
      cy = (-hy * o.h) / 2 + (hy * hgt) / 2;
    }
    if (o.kind === "text") {
      // text grows by its font size, not by stretching
      const k = hx ? w / o.w : hgt / o.h;
      l.size = Math.max(6, Math.round(o.size * k));
      fitText(l);
      const [nx, ny] = toWorld(
        o,
        (-hx * o.w) / 2 + (hx * l.w) / 2,
        (-hy * o.h) / 2 + (hy * l.h) / 2
      );
      l.x = nx;
      l.y = ny;
    } else {
      l.w = w;
      l.h = hgt;
      const [nx, ny] = toWorld(o, cx, cy);
      l.x = nx;
      l.y = ny;
    }
    this.changed();
  }

  private dragCreate(
    d: Extract<Drag, { type: "create" }>,
    wx: number,
    wy: number,
    shift: boolean
  ) {
    const l = this.layer(d.id);
    if (!l) return;
    let dx = wx - d.sx;
    let dy = wy - d.sy;
    const line = d.tool === "line" || d.tool === "arrow";
    if (shift) {
      if (line) {
        const a =
          Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        dx = Math.cos(a) * len;
        dy = Math.sin(a) * len;
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * m;
        dy = Math.sign(dy || 1) * m;
      }
    }
    l.x = d.sx + dx / 2;
    l.y = d.sy + dy / 2;
    l.w = Math.abs(dx);
    l.h = Math.abs(dy);
    l.flip = line && dx * dy < 0;
    this.changed();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.guides = {};
    if (this.canvas.hasPointerCapture(e.pointerId))
      this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.type === "move") {
      if (d.moved) this.commit();
      else this.draw();
    } else if (d.type === "resize" || d.type === "rotate") this.commit();
    else if (d.type === "create") {
      const l = this.layer(d.id);
      if (l && l.w < 4 && l.h < 4) {
        // a plain click makes a default-sized shape
        const line = d.tool === "line" || d.tool === "arrow";
        l.w = line ? 240 : 200;
        l.h = line ? 0 : 200;
        l.x = d.sx + (line ? 120 : 0);
        l.y = d.sy + (line ? 0 : 0);
        if (line) l.h = 1;
      }
      this.setTool("select");
      this.commit();
    } else if (d.type === "pen") this.finishPen(d.pts);
    else this.draw();
  }

  private finishPen(pts: number[]) {
    if (pts.length < 4) {
      this.draw();
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    const w = Math.max(1, x1 - x0);
    const hgt = Math.max(1, y1 - y0);
    const norm: number[] = [];
    for (let i = 0; i < pts.length; i += 2)
      norm.push((pts[i] - x0) / w, (pts[i + 1] - y0) / hgt);
    const p = store.settings.images;
    this.add(
      newLayer("path", {
        x: x0 + w / 2,
        y: y0 + hgt / 2,
        w,
        h: hgt,
        pts: norm,
        stroke: p.stroke,
        sw: Math.max(2, p.strokeWidth || 6),
      })
    );
  }

  private cursor(e: PointerEvent) {
    const [sx, sy] = this.screenPoint(e);
    const c = this.canvas.style;
    if (this.spaceDown) c.cursor = "grab";
    else if (this.tool !== "select")
      c.cursor = this.tool === "text" ? "text" : "crosshair";
    else {
      const hd = this.pickHandle(sx, sy);
      if (hd?.type === "rotate") c.cursor = "alias";
      else if (hd?.type === "resize")
        c.cursor =
          hd.handle.hx && hd.handle.hy
            ? hd.handle.hx === hd.handle.hy
              ? "nwse-resize"
              : "nesw-resize"
            : hd.handle.hx
              ? "ew-resize"
              : "ns-resize";
      else {
        const [wx, wy] = this.world(e);
        c.cursor = this.topAt(wx, wy) ? "move" : "default";
      }
    }
  }

  setTool(t: Tool) {
    this.tool = t;
    this.canvas.style.cursor = t === "select" ? "default" : "crosshair";
    this.onTool();
  }

  // ---- text

  private doubleClick(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - this.view.x) / this.view.zoom;
    const wy = (e.clientY - r.top - this.view.y) / this.view.zoom;
    const hit = this.topAt(wx, wy);
    if (hit?.kind === "text") this.editText(hit.id);
  }

  /** Type straight onto the canvas: a textarea sits over the layer while editing. */
  editText(id: string, selectAll = false) {
    const l = this.layer(id);
    if (!l || l.kind !== "text") return;
    this.commitText();
    const ta = h("textarea", { class: "ie-text", spellcheck: "false" });
    ta.value = l.text;
    const place = () => {
      const [x, y] = this.screen(l.x - l.w / 2, l.y - l.h / 2);
      const z = this.view.zoom;
      Object.assign(ta.style, {
        left: `${x}px`,
        top: `${y}px`,
        minWidth: `${Math.max(l.w * z, 40)}px`,
        width: `${Math.max(l.w * z + 24, 60)}px`,
        height: `${Math.max(l.h * z, l.size * z * 1.2)}px`,
        font: `${l.bold ? 700 : 400} ${l.size * z}px "${l.font}"`,
        lineHeight: "1.2",
        textAlign: l.align,
        color: l.fill ?? "#fff",
        transform: `rotate(${l.rot}deg)`,
      });
    };
    ta.addEventListener("input", () => {
      l.text = ta.value || " ";
      fitText(l);
      place();
      this.changed();
    });
    ta.addEventListener("keydown", e => {
      e.stopPropagation();
      if (
        e.key === "Escape" ||
        (e.key === "Enter" && (e.ctrlKey || e.metaKey))
      ) {
        e.preventDefault();
        this.commitText();
      }
    });
    ta.addEventListener("blur", () => this.commitText());
    this.editor = ta;
    this.el.append(ta);
    place();
    ta.focus();
    if (selectAll) ta.select();
  }

  commitText() {
    const ta = this.editor;
    if (!ta) return;
    this.editor = null;
    ta.remove();
    this.commit();
  }

  get editing() {
    return this.editor !== null;
  }

  // ---- keyboard

  private keyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      this.spaceDown = false;
      this.canvas.style.cursor = "default";
    }
  };

  nudge(dx: number, dy: number) {
    for (const l of this.selected) {
      if (l.locked) continue;
      l.x += dx;
      l.y += dy;
    }
    this.commit();
  }

  /** Handle a key press. Returns true when the editor used it. */
  key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === "Space" && !mod) {
      this.spaceDown = true;
      this.canvas.style.cursor = "grab";
      return true;
    }
    if (mod) {
      if (k === "z")
        return e.shiftKey ? (this.redo(), true) : (this.undo(), true);
      if (k === "y") return (this.redo(), true);
      if (k === "d") return (this.duplicate(), true);
      if (k === "a")
        return (
          this.select(
            this.doc.layers.filter(l => !l.locked && !l.hidden).map(l => l.id)
          ),
          true
        );
      if (k === "c" && !e.shiftKey) return this.copy();
      if (k === "x") return this.copy() && (this.remove(), true);
      if (k === "0") return (this.fit(), true);
      if (k === "=" || k === "+")
        return (this.zoomTo(this.view.zoom * 1.25), true);
      if (k === "-") return (this.zoomTo(this.view.zoom / 1.25), true);
      if (k === "]") return (this.restack(this.sel, Infinity), true);
      if (k === "[") return (this.restack(this.sel, -Infinity), true);
      return false;
    }
    if (e.altKey) return false;
    if (TOOL_KEYS[k]) return (this.setTool(TOOL_KEYS[k]), true);
    if (k === "[") return (this.restack(this.sel, -1), true);
    if (k === "]") return (this.restack(this.sel, 1), true);
    if (k === "1") return (this.zoomTo(1), true);
    if (k === "delete" || k === "backspace")
      return this.sel.length > 0 && (this.remove(), true);
    if (k === "escape") {
      if (this.tool !== "select") this.setTool("select");
      else if (this.sel.length) this.select([]);
      return true;
    }
    if (
      k === "enter" &&
      this.selected.length === 1 &&
      this.selected[0].kind === "text"
    )
      return (this.editText(this.selected[0].id, true), true);
    const step = e.shiftKey ? 10 : 1;
    if (k === "arrowleft") return (this.nudge(-step, 0), true);
    if (k === "arrowright") return (this.nudge(step, 0), true);
    if (k === "arrowup") return (this.nudge(0, -step), true);
    if (k === "arrowdown") return (this.nudge(0, step), true);
    return false;
  }

  /** Rotation of a layer, kept in 0-360 for the panel. */
  static normRot(deg: number) {
    return (((Math.round(deg * 10) / 10) % 360) + 360) % 360;
  }

  static readonly rad = rad;
  static readonly cloneDoc = cloneDoc;
}
