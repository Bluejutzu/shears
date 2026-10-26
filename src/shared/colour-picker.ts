import { ChevronsUpDown, Pipette } from "lucide";

import {
  hexToRgb,
  hslToRgb,
  hsvToRgb,
  parseColour,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  type Hsv,
} from "./colour";
import { closeMenu, h, icon, popups } from "./ui";

const RECENT_KEY = "shears:recent-colours";

const recents = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};

const remember = (hex: string) => {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([hex, ...recents().filter(x => x !== hex)].slice(0, 8))
    );
  } catch {
    // no recent colors without storage
  }
};

export const SUGGESTED = [
  "#ffffff",
  "#000000",
  "#f06e64",
  "#e49c42",
  "#f2d95c",
  "#93a877",
  "#5fb3a8",
  "#6a9bcc",
];

const toHsv = (hex: string): Hsv => rgbToHsv(...hexToRgb(hex));
const toHex = ([h, s, v]: Hsv) => rgbToHex(...hsvToRgb(h, s, v));
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Follows the pointer from press to release, even off the element. */
function drag(el: HTMLElement, move: (x: number, y: number) => void) {
  el.addEventListener("pointerdown", e => {
    e.preventDefault();
    el.focus({ preventScroll: true });
    el.setPointerCapture(e.pointerId);
    const at = (p: PointerEvent) => {
      const r = el.getBoundingClientRect();
      move(
        clamp((p.clientX - r.left) / r.width),
        clamp((p.clientY - r.top) / r.height)
      );
    };
    at(e);
    const stop = () => {
      el.removeEventListener("pointermove", at);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
    };
    el.addEventListener("pointermove", at);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
  });
}

type Mode = "HEX" | "RGB" | "HSL";
const NEXT: Record<Mode, Mode> = { HEX: "RGB", RGB: "HSL", HSL: "HEX" };

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

/**
 * The picker itself: a square for strength and brightness, a strip for the hue,
 * the color as typed text, and colors to pick straight away.
 */
export function colourPanel(start: string, onChange: (hex: string) => void) {
  let hsv = toHsv(start);
  let mode: Mode = "HEX";
  const original = start;
  const hex = () => toHex(hsv);

  const thumbShadow =
    "0 0 0 2.5px #fff, 0 0 0 3.5px rgba(0,0,0,.25), 0 2px 8px rgba(0,0,0,.35)";

  // ---- square
  const squareThumb = h("span", { class: "cp-thumb" });
  const square = h(
    "div",
    {
      class: "cp-square",
      role: "slider",
      tabindex: "0",
      "aria-label": "Strength and brightness",
    },
    squareThumb
  );
  drag(square, (x, y) => pick([hsv[0], x, 1 - y]));
  square.addEventListener("keydown", e => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    pick([hsv[0], clamp(hsv[1] + m[0]), clamp(hsv[2] + m[1])]);
  });

  // ---- hue strip
  const hueThumb = h("span", { class: "cp-thumb" });
  const strip = h(
    "div",
    {
      class: "cp-hue",
      role: "slider",
      tabindex: "0",
      "aria-label": "Hue",
      "aria-valuemin": "0",
      "aria-valuemax": "360",
    },
    hueThumb
  );
  drag(strip, x => pick([Math.min(x * 360, 359.9), hsv[1], hsv[2]]));
  strip.addEventListener("keydown", e => {
    const step = e.shiftKey ? 10 : 1;
    const next = {
      ArrowLeft: hsv[0] - step,
      ArrowDown: hsv[0] - step,
      ArrowRight: hsv[0] + step,
      ArrowUp: hsv[0] + step,
      Home: 0,
      End: 359.9,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    pick([Math.min(Math.max(next, 0), 359.9), hsv[1], hsv[2]]);
  });

  // ---- before / after
  const after = h("span", { class: "cp-after" });
  const compare = h(
    "span",
    { class: "cp-compare", title: "Before and after" },
    h("span", { style: `background:${original}` }),
    after
  );

  const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor })
    .EyeDropper;
  const dropper = EyeDropper
    ? h(
        "button",
        {
          class: "cp-btn",
          type: "button",
          title: "Pick a color from anywhere on screen",
          onclick: () =>
            new EyeDropper()
              .open()
              .then(r => pickHex(r.sRGBHex))
              .catch(() => {}),
        },
        icon(Pipette, 15)
      )
    : null;

  // ---- typed values
  const modeBtn = h(
    "button",
    {
      class: "cp-mode",
      type: "button",
      title: "Switch between hex, RGB and HSL",
      onclick: () => {
        mode = NEXT[mode];
        buildFields();
      },
    },
    h("span"),
    icon(ChevronsUpDown, 12)
  );
  const fields = h("div", { class: "cp-fields" });
  let inputs: { key: string; el: HTMLInputElement }[] = [];

  const values = () => {
    const [r, g, b] = hexToRgb(hex());
    const [hh, s, l] = rgbToHsl(r, g, b);
    return {
      hex: hex().toUpperCase(),
      r,
      g,
      b,
      h: Math.round(hh),
      s: Math.round(s * 100),
      l: Math.round(l * 100),
    } as Record<string, string | number>;
  };

  function buildFields() {
    modeBtn.firstElementChild!.textContent = mode;
    const spec =
      mode === "HEX"
        ? [{ key: "hex", unit: "", max: 0 }]
        : mode === "RGB"
          ? [
              { key: "r", unit: "R", max: 255 },
              { key: "g", unit: "G", max: 255 },
              { key: "b", unit: "B", max: 255 },
            ]
          : [
              { key: "h", unit: "°", max: 360 },
              { key: "s", unit: "%", max: 100 },
              { key: "l", unit: "%", max: 100 },
            ];
    inputs = spec.map(({ key, unit, max }) => {
      const el = h("input", {
        class: "cp-input",
        spellcheck: "false",
        autocomplete: "off",
        "aria-label": key === "hex" ? "Hex color" : key.toUpperCase(),
      });
      const read = () => {
        if (mode === "HEX") {
          const parsed = parseColour(el.value);
          el.classList.toggle("bad", !parsed);
          return parsed;
        }
        const nums = inputs.map(i => i.el.value);
        const ok = inputs.every(
          (_, n) =>
            nums[n] !== "" &&
            Number(nums[n]) >= 0 &&
            Number(nums[n]) <= spec[n]!.max
        );
        inputs.forEach(i => i.el.classList.remove("bad"));
        if (!ok) {
          el.classList.add("bad");
          return null;
        }
        const [x, y, z] = nums.map(Number) as [number, number, number];
        return mode === "RGB"
          ? rgbToHex(x, y, z)
          : rgbToHex(...hslToRgb(x % 360, y / 100, z / 100));
      };
      el.addEventListener("input", () => {
        const parsed = read();
        if (parsed) pickHex(parsed, el);
      });
      el.addEventListener("blur", () => {
        el.classList.remove("bad");
        paint();
      });
      el.addEventListener("keydown", e => {
        if (key === "hex" || (e.key !== "ArrowUp" && e.key !== "ArrowDown"))
          return;
        e.preventDefault();
        const step = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
        el.value = String(Math.min(max, Math.max(0, Number(el.value) + step)));
        el.dispatchEvent(new Event("input"));
      });
      fields.append(
        h(
          "label",
          { class: "cp-field" },
          el,
          unit ? h("span", { class: "cp-unit" }, unit) : null
        )
      );
      return { key, el };
    });
    fields.replaceChildren(...inputs.map(i => i.el.parentElement!));
    paint();
  }

  // ---- swatches
  const swatches = (title: string, list: string[]) =>
    list.length
      ? h(
          "div",
          {},
          h("p", { class: "cp-title" }, title),
          h(
            "div",
            { class: "cp-swatches" },
            ...list.map(c =>
              h("button", {
                class: "cp-swatch",
                type: "button",
                title: c,
                "aria-label": c,
                style: `background:${c}`,
                onclick: () => pickHex(c),
              })
            )
          )
        )
      : null;

  const el = h(
    "div",
    { class: "cp" },
    square,
    h("div", { class: "cp-row" }, dropper, strip, compare),
    h("div", { class: "cp-row" }, modeBtn, fields),
    swatches("Suggested", SUGGESTED),
    swatches("Recent", recents())
  );

  /** Puts everything on screen where the color now is; `typing` keeps the box being typed in. */
  function paint(typing?: HTMLInputElement) {
    const c = hex();
    square.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent),hsl(${hsv[0]} 100% 50%)`;
    squareThumb.style.cssText = `left:${hsv[1] * 100}%;top:${(1 - hsv[2]) * 100}%;background:${c};box-shadow:${thumbShadow}`;
    strip.setAttribute("aria-valuenow", String(Math.round(hsv[0])));
    hueThumb.style.cssText = `left:${(hsv[0] / 360) * 100}%;background:hsl(${hsv[0]} 100% 50%);box-shadow:${thumbShadow}`;
    after.style.background = c;
    const v = values();
    for (const i of inputs)
      if (i.el !== typing && i.el !== document.activeElement)
        i.el.value = String(v[i.key]);
  }

  function pick(next: Hsv, typing?: HTMLInputElement) {
    hsv = next;
    paint(typing);
    onChange(hex());
  }

  // a grey has no hue of its own, so keep the one that was showing
  function pickHex(colour: string, typing?: HTMLInputElement) {
    const next = toHsv(colour);
    pick(
      next[1] === 0 || next[2] === 0 ? [hsv[0], next[1], next[2]] : next,
      typing
    );
  }

  buildFields();

  return {
    el,
    /** Follows a change from outside. */
    set(colour: string) {
      if (colour === hex()) return;
      const next = toHsv(colour);
      hsv = next[1] === 0 || next[2] === 0 ? [hsv[0], next[1], next[2]] : next;
      paint();
    },
  };
}

/**
 * A color swatch button that opens the picker in a popover next to it. Changes show
 * as they're made; Escape puts the color back to how it was.
 */
export function colourInput(opts: {
  value: string;
  onInput: (hex: string) => void;
  /** Called once when the picker closes with a different color than it opened with. */
  onCommit?: () => void;
  title?: string;
  disabled?: boolean;
}) {
  let value = opts.value;
  let close: (keep: boolean) => void = () => {};
  const btn = h("button", {
    class: "color-input",
    type: "button",
    title: opts.title ?? "Pick a color",
    "aria-label": opts.title ?? "Pick a color",
    disabled: opts.disabled,
  });
  const show = () => (btn.style.background = value);
  show();

  btn.addEventListener("click", () => {
    if (popups.has(btn)) return close(true);
    closeMenu();
    const before = value;
    const panel = colourPanel(value, hex => {
      value = hex;
      show();
      opts.onInput(hex);
    });
    const pop = h("div", { class: "cp-pop", role: "dialog" }, panel.el);
    document.body.append(pop);
    popups.add(btn);

    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const above = r.bottom + ph + 12 > innerHeight && r.top > ph + 12;
    pop.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
    pop.style.top = `${Math.max(8, above ? r.top - ph - 6 : r.bottom + 6)}px`;

    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.contains(t) && !btn.contains(t)) close(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(false);
    };
    // a tick later so the click that opened it doesn't close it again
    const listen = setTimeout(
      () => document.addEventListener("pointerdown", onDown),
      0
    );
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", () => close(true), { once: true });

    close = keep => {
      close = () => {};
      clearTimeout(listen);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      pop.remove();
      // later, so the dialog's Escape in this same keypress doesn't close with us
      setTimeout(() => popups.delete(btn), 0);
      if (!keep) {
        value = before;
        show();
        opts.onInput(before);
      } else if (value !== before) {
        remember(value);
        opts.onCommit?.();
      }
      btn.focus({ preventScroll: true });
    };
  });

  return btn;
}
