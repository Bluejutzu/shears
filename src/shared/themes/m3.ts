// Material 3 theme. The palette generator and the blurred banner background follow how Riff
// (https://github.com/rootscripts/riff, MIT) builds its look: one accent hue turns into a full
// set of tinted surfaces, and the current clip's frame sits blurred behind the panels.
import "@fontsource-variable/google-sans-flex";
import "./m3.css";

export type M3Prefs = { hue: number; intensity: number; brightness: number };

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

function hslToHex(h: number, s: number, l: number) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return `#${[f(0), f(8), f(4)]
    .map(x =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Dark Material 3 palette from one hue, the way Riff's generator does it. */
export function palette({ hue: h, intensity, brightness }: M3Prefs) {
  const k = clamp(intensity, 0, 100) / 100;
  const br = clamp(brightness, 0, 100) / 100;
  const B = (v: number) => clamp(Math.round(v * br * 2), 0, 100);
  const mono = k < 0.08;
  const sat = Math.round(60 * k);
  const satMed = Math.round(50 * k);
  const satLow = Math.round(15 * k);
  const satLow2 = Math.round(30 * k);
  const surf = (s: number) => (mono ? 0 : Math.round(s * k));

  const primary = mono ? "#ffffff" : hslToHex(h, sat, 75);
  return {
    primary,
    onPrimary: mono ? "#121212" : hslToHex(h, satMed, 20),
    primaryContainer: rgba(primary, 0.18),
    onPrimaryContainer: primary,
    secondaryContainer: mono ? hslToHex(0, 0, B(24)) : hslToHex(h, satLow, 22),
    onSecondaryContainer: mono ? "#ffffff" : hslToHex(h, satLow2, 85),
    // M3's tertiary sits a sixth of the way round the color wheel from the primary
    tertiary: mono ? "#bdbdbd" : hslToHex((h + 60) % 360, sat, 75),
    background: hslToHex(h, surf(5), B(7)),
    surface: hslToHex(h, surf(6), B(8)),
    bright: hslToHex(h, surf(4), B(24)),
    lowest: hslToHex(h, surf(5), B(5)),
    low: hslToHex(h, surf(5), B(10)),
    container: hslToHex(h, surf(6), B(13)),
    high: hslToHex(h, surf(5), B(16)),
    highest: hslToHex(h, surf(5), B(20)),
    onSurface: mono ? "#ffffff" : "#e2e2e9",
    onSurfaceVariant: mono ? "#cfcfcf" : "#c4c6d0",
    outline: mono ? "#8a8a8a" : "#8e9099",
    outlineVariant: mono ? "#3a3a3a" : "#30323b",
    error: "#f2b8b5",
    onError: "#601410",
    mesh: hslToHex(h, mono ? 0 : 70, 55),
  };
}

export function apply(prefs: M3Prefs) {
  const p = palette(prefs);
  const root = document.documentElement.style;
  const set = (name: string, value: string) => root.setProperty(name, value);
  set("--md-primary", p.primary);
  set("--md-tertiary", p.tertiary);
  set("--md-on-primary", p.onPrimary);
  set("--md-primary-container", p.primaryContainer);
  set("--md-on-primary-container", p.onPrimaryContainer);
  set("--md-secondary-container", p.secondaryContainer);
  set("--md-on-secondary-container", p.onSecondaryContainer);
  set("--md-background", p.background);
  set("--md-surface", p.surface);
  set("--md-surface-bright", p.bright);
  set("--md-container-lowest", p.lowest);
  set("--md-container-low", p.low);
  set("--md-container", p.container);
  set("--md-container-high", p.high);
  set("--md-container-highest", p.highest);
  set("--md-on-surface", p.onSurface);
  set("--md-on-surface-variant", p.onSurfaceVariant);
  set("--md-outline", p.outline);
  set("--md-outline-variant", p.outlineVariant);
  set("--md-error", p.error);
  set("--md-on-error", p.onError);
  set("--md-mesh", rgba(p.mesh, 0.32));

  // the timeline is drawn on a canvas, so it gets plain colors instead of css mixes
  set("--tl-clip", p.highest);
  set("--tl-audio-clip", p.secondaryContainer);
  set("--tl-clip-off", p.lowest);
  set("--tl-lane", rgba(p.onSurface, 0.03));
  set("--tl-border", rgba(p.onSurface, 0.1));
  set("--tl-selected", p.onSurface);
  set("--tl-wave", p.primary);
  set("--tl-wave-muted", p.outline);
  set("--tl-wave-off", p.high);
  set("--tl-dim", rgba(p.background, 0.55));
  set("--tl-hatch", rgba(p.onSurface, 0.05));
  set("--tl-tick", rgba(p.onSurface, 0.2));
  set("--tl-label", p.outline);
  set("--tl-range", rgba(p.primary, 0.1));
  set("--tl-range-edge", p.primary);
  set("--tl-playhead", p.primary);
  set("--tl-hover", rgba(p.onSurface, 0.3));
  set("--tl-pill", p.highest);
  set("--tl-pill-text", p.onSurface);
  set("--tl-mini", p.bright);
  set("--tl-mini-off", p.high);
  set("--tl-vol-line", rgba(p.onSurface, 0.6));
  set("--tl-vol-active", p.primary);
}

// ---- expressive sliders need to know how far along they are

function syncRanges() {
  for (const el of document.querySelectorAll<HTMLInputElement>(
    "input[type=range]"
  )) {
    const min = +el.min || 0;
    const max = el.max === "" ? 100 : +el.max;
    const v = String((+el.value - min) / (max - min || 1));
    if (el.style.getPropertyValue("--v") !== v) el.style.setProperty("--v", v);
  }
  requestAnimationFrame(syncRanges);
}

// ---- blurred banner of the current clip behind everything, like Riff's banners

let banner: HTMLElement | null = null;

function setBanner(url: string | null) {
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "m3-banner";
    document.body.prepend(banner);
  }
  const next = document.createElement("div");
  next.className = "m3-banner-img";
  if (url) next.style.backgroundImage = `url("${url}")`;
  banner.append(next);
  requestAnimationFrame(() => next.classList.add("show"));
  // cross-fade, then drop the old layers
  setTimeout(() => {
    while (banner!.children.length > 1) banner!.firstElementChild!.remove();
  }, 700);
}

export function init(prefs: M3Prefs) {
  document.documentElement.classList.add("theme-m3");
  apply(prefs);
  requestAnimationFrame(syncRanges);
  setBanner(null);
}

export const api = { banner: setBanner, apply };
