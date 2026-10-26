// Colour maths for the colour picker: conversions between hex, RGB, HSV and HSL.

export type Rgb = [number, number, number];
export type Hsv = [number, number, number];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function hexToRgb(hex: string): Rgb {
  let digits = hex.replace("#", "");
  if (digits.length === 3) digits = [...digits].map(c => c + c).join("");
  const value = Number.parseInt(digits, 16) || 0;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export const rgbToHex = (r: number, g: number, b: number) =>
  "#" +
  [r, g, b]
    .map(part =>
      Math.round(clamp(part, 0, 255))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");

/** Hue in degrees, saturation and value from 0 to 1. */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const part = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(Math.min(k, 4 - k, 1), 0)) * 255;
  };
  return [part(5), part(3), part(1)];
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const range = max - Math.min(r, g, b);
  let hue = 0;
  if (range)
    hue =
      max === r
        ? ((g - b) / range) % 6
        : max === g
          ? (b - r) / range + 2
          : (r - g) / range + 4;
  return [(hue * 60 + 360) % 360, max ? range / max : 0, max];
}

export function rgbToHsl(r: number, g: number, b: number): Hsv {
  const [h, s, v] = rgbToHsv(r, g, b);
  const l = v * (1 - s / 2);
  return [h, l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb(h, v ? 2 * (1 - l / v) : 0, v);
}

/** Reads "#abc", "#aabbcc", "rgb(…)" or "hsl(…)", the ways people tend to paste a colour. */
export function parseColour(text: string) {
  const value = text.trim().toLowerCase();
  let match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (match) return rgbToHex(...hexToRgb(match[1]!));
  match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  if (match)
    return rgbToHex(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(
    value
  );
  if (match)
    return rgbToHex(
      ...hslToRgb(
        Number(match[1]) % 360,
        Number(match[2]) / 100,
        Number(match[3]) / 100
      )
    );
  return null;
}
