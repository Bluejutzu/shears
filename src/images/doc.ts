import { fileUrl } from "../api";

export type Gradient = { from: string; to: string; angle: number };
/** null is transparent, a string is a solid color */
export type Bg = string | Gradient | null;

export type LayerKind =
  | "rect"
  | "ellipse"
  | "triangle"
  | "line"
  | "arrow"
  | "path"
  | "text"
  | "image";

/** x/y are the center. Rotation is in degrees. */
export type Layer = {
  id: string;
  name: string;
  kind: LayerKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  opacity: number;
  hidden: boolean;
  locked: boolean;
  fill: string | null;
  stroke: string | null;
  sw: number;
  radius: number;
  /** lines run top-left to bottom-right, flipped they run bottom-left to top-right */
  flip: boolean;
  /** a pen stroke: x,y pairs as fractions of the box */
  pts: number[];
  text: string;
  size: number;
  bold: boolean;
  align: "left" | "center" | "right";
  font: string;
  /** data url of the picture */
  src: string;
};

export type ImageMeta = { tags: Record<string, string | null>; strip: boolean };

export type Doc = {
  w: number;
  h: number;
  bg: Bg;
  layers: Layer[];
  /** tag changes to write into exported PNG and JPEG files */
  meta?: ImageMeta;
};

export const SIZES: Record<string, { label: string; w: number; h: number }> = {
  video: { label: "Video frame", w: 1920, h: 1080 },
  vertical: { label: "Vertical video", w: 1080, h: 1920 },
  square: { label: "Square", w: 1080, h: 1080 },
  thumb: { label: "Thumbnail", w: 1280, h: 720 },
  uhd: { label: "4K frame", w: 3840, h: 2160 },
  sticker: { label: "Sticker", w: 512, h: 512 },
};

export const FONTS = [
  "Segoe UI",
  "Arial",
  "Georgia",
  "Impact",
  "Consolas",
  "Comic Sans MS",
];

let counter = 0;
export const newId = (prefix = "l") =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 4)}`;

export function newLayer(kind: LayerKind, patch: Partial<Layer> = {}): Layer {
  const names: Record<LayerKind, string> = {
    rect: "Rectangle",
    ellipse: "Ellipse",
    triangle: "Triangle",
    line: "Line",
    arrow: "Arrow",
    path: "Drawing",
    text: "Text",
    image: "Image",
  };
  return {
    id: newId(),
    name: names[kind],
    kind,
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    rot: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    fill: null,
    stroke: null,
    sw: 0,
    radius: 0,
    flip: false,
    pts: [],
    text: "Text",
    size: 72,
    bold: true,
    align: "left",
    font: FONTS[0],
    src: "",
    ...patch,
  };
}

export const cloneDoc = (d: Doc): Doc => structuredClone(d);

// ---- pictures: decoded once per source and shared

const pictures = new Map<string, HTMLImageElement>();

export function picture(src: string, onLoad?: () => void) {
  let img = pictures.get(src);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.src = src;
    pictures.set(src, img);
  }
  if (onLoad && !img.complete)
    img.addEventListener("load", onLoad, { once: true });
  return img;
}

export function loadPicture(src: string) {
  const img = picture(src);
  if (img.complete && img.naturalWidth) return Promise.resolve(img);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.addEventListener("load", () => resolve(img), { once: true });
    img.addEventListener("error", () => reject(new Error("unreadable image")), {
      once: true,
    });
  });
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function fileToDataUrl(path: string) {
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error("couldn't read that file");
  return blobToDataUrl(await res.blob());
}

// ---- drawing

const measureCtx = document.createElement("canvas").getContext("2d")!;

const fontOf = (l: Layer) => `${l.bold ? 700 : 400} ${l.size}px "${l.font}"`;

/** Text layers size themselves to their text. */
export function fitText(l: Layer) {
  measureCtx.font = fontOf(l);
  const lines = l.text.split("\n");
  l.w = Math.max(10, ...lines.map(x => measureCtx.measureText(x).width));
  l.h = Math.max(10, lines.length * l.size * 1.2);
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number
) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - size * Math.cos(a - Math.PI / 7),
    y2 - size * Math.sin(a - Math.PI / 7)
  );
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - size * Math.cos(a + Math.PI / 7),
    y2 - size * Math.sin(a + Math.PI / 7)
  );
  ctx.stroke();
}

/** The end points of a line layer, in its own (unrotated) space. */
export function lineEnds(l: Layer): [number, number, number, number] {
  const x = -l.w / 2;
  const y = -l.h / 2;
  return l.flip ? [x, y + l.h, x + l.w, y] : [x, y, x + l.w, y + l.h];
}

export function drawLayer(
  ctx: CanvasRenderingContext2D,
  l: Layer,
  onLoad?: () => void
) {
  if (l.hidden) return;
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.translate(l.x, l.y);
  ctx.rotate((l.rot * Math.PI) / 180);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = l.sw;
  const x = -l.w / 2;
  const y = -l.h / 2;
  const paint = () => {
    if (l.fill) {
      ctx.fillStyle = l.fill;
      ctx.fill();
    }
    if (l.stroke && l.sw > 0) {
      ctx.strokeStyle = l.stroke;
      ctx.stroke();
    }
  };
  if (l.kind === "rect") {
    ctx.beginPath();
    ctx.roundRect(x, y, l.w, l.h, Math.min(l.radius, l.w / 2, l.h / 2));
    paint();
  } else if (l.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, l.w / 2, l.h / 2, 0, 0, Math.PI * 2);
    paint();
  } else if (l.kind === "triangle") {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(x + l.w, y + l.h);
    ctx.lineTo(x, y + l.h);
    ctx.closePath();
    paint();
  } else if (l.kind === "line" || l.kind === "arrow") {
    const [x1, y1, x2, y2] = lineEnds(l);
    ctx.strokeStyle = l.stroke ?? l.fill ?? "#ffffff";
    ctx.lineWidth = Math.max(1, l.sw);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (l.kind === "arrow")
      arrowHead(ctx, x1, y1, x2, y2, Math.max(14, l.sw * 4));
  } else if (l.kind === "path") {
    ctx.strokeStyle = l.stroke ?? l.fill ?? "#ffffff";
    ctx.lineWidth = Math.max(1, l.sw);
    ctx.beginPath();
    for (let i = 0; i < l.pts.length; i += 2) {
      const px = x + l.pts[i] * l.w;
      const py = y + l.pts[i + 1] * l.h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else if (l.kind === "text") {
    ctx.font = fontOf(l);
    ctx.textBaseline = "top";
    ctx.textAlign = l.align;
    const tx = l.align === "left" ? x : l.align === "right" ? -x : 0;
    l.text.split("\n").forEach((line, i) => {
      const ty = y + i * l.size * 1.2 + l.size * 0.1;
      if (l.stroke && l.sw > 0) {
        ctx.strokeStyle = l.stroke;
        ctx.strokeText(line, tx, ty);
      }
      ctx.fillStyle = l.fill ?? "#ffffff";
      ctx.fillText(line, tx, ty);
    });
  } else if (l.kind === "image") {
    const img = picture(l.src, onLoad);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, x, y, l.w, l.h);
  }
  ctx.restore();
}

export function drawBg(ctx: CanvasRenderingContext2D, d: Doc) {
  if (!d.bg) return;
  if (typeof d.bg === "string") ctx.fillStyle = d.bg;
  else {
    const a = (d.bg.angle * Math.PI) / 180;
    const cx = d.w / 2;
    const cy = d.h / 2;
    const r = Math.hypot(d.w, d.h) / 2;
    const g = ctx.createLinearGradient(
      cx - Math.sin(a) * r,
      cy + Math.cos(a) * r,
      cx + Math.sin(a) * r,
      cy - Math.cos(a) * r
    );
    g.addColorStop(0, d.bg.from);
    g.addColorStop(1, d.bg.to);
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, d.w, d.h);
}

/** Render the whole picture at full size (waits for pictures to decode first). */
export async function renderDoc(d: Doc) {
  await Promise.all(
    d.layers
      .filter(l => l.kind === "image")
      .map(l => loadPicture(l.src).catch(() => null))
  );
  const c = document.createElement("canvas");
  c.width = d.w;
  c.height = d.h;
  const ctx = c.getContext("2d")!;
  drawBg(ctx, d);
  for (const l of d.layers) drawLayer(ctx, l);
  return c;
}

export const toPng = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      b => (b ? resolve(b) : reject(new Error("couldn't encode"))),
      "image/png"
    )
  );

// ---- geometry

export const rad = (deg: number) => (deg * Math.PI) / 180;

/** A point in the picture, taken into a layer's own space. */
export function toLocal(l: Layer, px: number, py: number): [number, number] {
  const a = rad(-l.rot);
  const dx = px - l.x;
  const dy = py - l.y;
  return [
    dx * Math.cos(a) - dy * Math.sin(a),
    dx * Math.sin(a) + dy * Math.cos(a),
  ];
}

export function toWorld(l: Layer, lx: number, ly: number): [number, number] {
  const a = rad(l.rot);
  return [
    l.x + lx * Math.cos(a) - ly * Math.sin(a),
    l.y + lx * Math.sin(a) + ly * Math.cos(a),
  ];
}

function segDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len
    ? Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / len))
    : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitLayer(l: Layer, px: number, py: number, tol: number) {
  if (l.hidden) return false;
  const [lx, ly] = toLocal(l, px, py);
  if (l.kind === "line" || l.kind === "arrow") {
    const [x1, y1, x2, y2] = lineEnds(l);
    return segDist(lx, ly, x1, y1, x2, y2) <= Math.max(l.sw, 1) / 2 + tol;
  }
  if (l.kind === "path") {
    const x = -l.w / 2;
    const y = -l.h / 2;
    for (let i = 2; i < l.pts.length; i += 2)
      if (
        segDist(
          lx,
          ly,
          x + l.pts[i - 2] * l.w,
          y + l.pts[i - 1] * l.h,
          x + l.pts[i] * l.w,
          y + l.pts[i + 1] * l.h
        ) <=
        Math.max(l.sw, 1) / 2 + tol
      )
        return true;
    return false;
  }
  if (l.kind === "ellipse") {
    const rx = l.w / 2 + tol;
    const ry = l.h / 2 + tol;
    return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
  }
  return Math.abs(lx) <= l.w / 2 + tol && Math.abs(ly) <= l.h / 2 + tol;
}
