import { fileUrl } from "../shared/api";
import { h } from "../shared/ui";
import type { Edit, Overlay } from "./edit";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

// one decoded image per file, shared by the timeline lanes and the preview
const cache = new Map<string, HTMLImageElement>();

export function getImage(path: string, onLoad?: () => void) {
  let img = cache.get(path);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = fileUrl(path);
    cache.set(path, img);
  }
  if (onLoad && !img.complete)
    img.addEventListener("load", onLoad, { once: true });
  return img;
}

/** Loads an image and resolves with its natural size (or rejects if it can't be read). */
export function imageSize(path: string) {
  const img = getImage(path);
  if (img.complete && img.naturalWidth)
    return Promise.resolve({ w: img.naturalWidth, h: img.naturalHeight });
  return new Promise<{ w: number; h: number }>((resolve, reject) => {
    img.addEventListener(
      "load",
      () => resolve({ w: img.naturalWidth, h: img.naturalHeight }),
      { once: true }
    );
    img.addEventListener("error", () => reject(new Error("unreadable")), {
      once: true,
    });
  });
}

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

/**
 * The overlays drawn over the preview. The layer sits exactly on the video frame, so
 * positions are fractions of the frame like in the export. Drag an image to move it
 * (it snaps to the middle), drag its corner to resize.
 */
export class OverlayLayer {
  readonly el = h("div", { class: "ov-layer" });
  private items = new Map<string, HTMLElement>();

  constructor(
    private edit: Edit,
    private select: (id: string) => void
  ) {}

  /** Line the layer up with the shown frame (the video is contained, maybe rotated). */
  place(boxW: number, boxH: number, frameW: number, frameH: number) {
    if (!frameW || !frameH || !boxW) return;
    const k = Math.min(boxW / frameW, boxH / frameH);
    const w = frameW * k;
    const hgt = frameH * k;
    Object.assign(this.el.style, {
      left: `${(boxW - w) / 2}px`,
      top: `${(boxH - hgt) / 2}px`,
      width: `${w}px`,
      height: `${hgt}px`,
    });
  }

  /** Rebuild after the overlays or the selection change. */
  update(time: number) {
    const e = this.edit;
    for (const [id, el] of this.items)
      if (!e.overlay(id)) {
        el.remove();
        this.items.delete(id);
      }
    e.overlays.forEach((o, i) => {
      let el = this.items.get(o.id);
      if (!el) {
        el = this.make(o.id);
        this.items.set(o.id, el);
        this.el.append(el);
      }
      const img = el.firstElementChild as HTMLImageElement;
      if (img.dataset.path !== o.path) {
        img.dataset.path = o.path;
        img.src = getImage(o.path).src;
      }
      Object.assign(el.style, {
        left: `${o.x * 100}%`,
        top: `${o.y * 100}%`,
        width: `${o.scale * 100}%`,
        opacity: String(o.opacity),
        zIndex: String(i + 1),
      });
      el.classList.toggle("selected", e.isSelected(o.id));
    });
    this.tick(time);
  }

  /** Show only the overlays on screen at this moment. Cheap enough to run every frame. */
  tick(time: number) {
    for (const o of this.edit.overlays) {
      const el = this.items.get(o.id);
      const hidden = time < o.start || time >= o.start + o.duration;
      if (el && el.hidden !== hidden) el.hidden = hidden;
    }
  }

  private make(id: string) {
    const handle = h("div", { class: "ov-handle" });
    const el = h(
      "div",
      { class: "ov-item", "data-id": id },
      h("img", { draggable: "false", alt: "" }),
      handle
    );
    el.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const o = this.edit.overlay(id);
      if (!o) return;
      this.select(id);
      this.edit.checkpoint();
      el.setPointerCapture(ev.pointerId);
      const box = this.el.getBoundingClientRect();
      const resizing = ev.target === handle;
      const from = { x: o.x, y: o.y, scale: o.scale };
      const sx = ev.clientX;
      const sy = ev.clientY;
      el.classList.add("dragging");
      const move = (m: PointerEvent) => {
        const dx = (m.clientX - sx) / box.width;
        const dy = (m.clientY - sy) / box.height;
        if (resizing) {
          // the image stays centered, so the corner moves half as far as the width grows
          o.scale =
            Math.round(clamp(from.scale + dx * 2, 0.02, 3) * 1000) / 1000;
        } else {
          let x = clamp(from.x + dx, 0, 1);
          let y = clamp(from.y + dy, 0, 1);
          // snap to the middle unless shift is held
          if (!m.shiftKey && Math.abs(x - 0.5) < 0.012) x = 0.5;
          if (!m.shiftKey && Math.abs(y - 0.5) < 0.012) y = 0.5;
          o.x = Math.round(x * 10000) / 10000;
          o.y = Math.round(y * 10000) / 10000;
          this.el.classList.toggle("guide-x", x === 0.5);
          this.el.classList.toggle("guide-y", y === 0.5);
        }
        this.edit.onChange();
      };
      const up = () => {
        el.classList.remove("dragging");
        this.el.classList.remove("guide-x", "guide-y");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    return el;
  }
}

/** A fresh overlay for an image, sized to sit comfortably inside the frame. */
export function newOverlay(
  path: string,
  name: string,
  start: number,
  duration: number,
  imgAspect: number,
  frameAspect: number
): Overlay {
  return {
    id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name,
    path,
    start,
    duration,
    x: 0.5,
    y: 0.5,
    // half the frame wide, unless that would make a tall image run off the top and bottom
    scale:
      Math.round(Math.min(0.5, (0.8 * imgAspect) / frameAspect) * 1000) / 1000,
    opacity: 1,
  };
}
