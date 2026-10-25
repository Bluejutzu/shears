import { Check, ChevronRight, X, createElement, type IconNode } from "lucide";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function icon(node: IconNode, size = 16, strokeWidth = 1.75) {
  return createElement(node, {
    width: size,
    height: size,
    "stroke-width": strokeWidth,
    class: "icon",
  });
}

export function fmt(t: number, precise = true) {
  if (!isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  const hrs = Math.floor(t / 3600);
  const min = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const s = precise
    ? sec.toFixed(2).padStart(5, "0")
    : String(Math.floor(sec)).padStart(2, "0");
  const body = hrs
    ? `${hrs}:${String(min).padStart(2, "0")}:${s}`
    : `${min}:${s}`;
  return neg ? `-${body}` : body;
}

export function fmtSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirname = (p: string) =>
  p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
export const stem = (p: string) => basename(p).replace(/\.[^.]+$/, "");
export const join = (dir: string, name: string) =>
  `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;
export const ext = (p: string) =>
  (/\.([^.\\/]+)$/.exec(p)?.[1] ?? "").toLowerCase();

export function kbd(combo: string) {
  return h(
    "span",
    { class: "kbd-group" },
    ...combo.split(" ").map(k => h("kbd", {}, k))
  );
}

// ---- form bits shared by the export dialog, properties panel and settings

export function segmented<T>(
  options: { label: string; value: T }[],
  value: T,
  pick: (v: T) => void
) {
  return h(
    "div",
    { class: "segmented" },
    ...options.map(o =>
      h(
        "button",
        {
          class: o.value === value ? "active" : "",
          onclick: () => pick(o.value),
        },
        o.label
      )
    )
  );
}

export function toggle(on: boolean, flip: (on: boolean) => void) {
  return h(
    "button",
    {
      class: `switch${on ? " on" : ""}`,
      role: "switch",
      "aria-checked": String(on),
      onclick: () => flip(!on),
    },
    h("span")
  );
}

export function row(label: string, control: Node, hint?: string) {
  return h(
    "div",
    { class: "form-row" },
    h("div", { class: "form-label" }, label),
    h(
      "div",
      { class: "form-control" },
      control,
      hint ? h("div", { class: "form-hint" }, hint) : null
    )
  );
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const fmtDb = (db: number) =>
  Math.abs(db) < 0.05
    ? "0 dB"
    : `${db > 0 ? "+" : "−"}${Math.abs(db).toFixed(1)} dB`;

/**
 * A progress bar: flat in the Shears theme, Material 3's wavy line in M3 (the theme's CSS
 * shows one or the other). `flat: false` leaves the flat one out entirely.
 */
export function progressBar({ flat = true } = {}) {
  const fill = h("div", { class: "progress-fill" });
  const wavy = h("div", { class: "wavy" });
  let wave = "M0 6";
  for (let x = 0; x < 2400; x += 40) wave += " q10 -7 20 0 t20 0";
  wavy.innerHTML = `<div class="wavy-fill"><svg width="2440" height="12" viewBox="0 0 2440 12"><path d="${wave}" /></svg></div><div class="wavy-track"></div>`;
  return {
    el: h(
      "div",
      { class: "progress-bar" },
      wavy,
      flat ? h("div", { class: "progress" }, fill) : null
    ),
    set(p: number) {
      fill.style.width = `${p * 100}%`;
      wavy.style.setProperty("--p", String(p));
    },
  };
}

// ---- tooltips: any element with data-tip gets a little dark pill on hover

let tipEl: HTMLElement | null = null;
let tipTimer = 0;

export function initTooltips() {
  tipEl = h("div", { class: "tooltip" });
  document.body.append(tipEl);
  document.addEventListener("pointerover", e => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    clearTimeout(tipTimer);
    tipEl!.classList.remove("show");
    if (!target) return;
    tipTimer = window.setTimeout(() => {
      if (!target.isConnected) return;
      tipEl!.replaceChildren(target.dataset.tip!);
      if (target.dataset.key) tipEl!.append(kbd(target.dataset.key));
      const r = target.getBoundingClientRect();
      const below = target.dataset.tipPos === "below" || r.top < 60;
      tipEl!.classList.add("show");
      const tr = tipEl!.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, r.left + r.width / 2 - tr.width / 2),
        innerWidth - tr.width - 8
      );
      tipEl!.style.left = `${left}px`;
      tipEl!.style.top = `${below ? r.bottom + 8 : r.top - tr.height - 8}px`;
    }, 450);
  });
  document.addEventListener("pointerdown", () => {
    clearTimeout(tipTimer);
    tipEl?.classList.remove("show");
  });
}

// ---- toasts

export function toast(
  title: string,
  opts: {
    body?: string;
    action?: { label: string; run: () => void };
    error?: boolean;
  } = {}
) {
  let host = document.querySelector(".toasts");
  if (!host) {
    host = h("div", { class: "toasts" });
    document.body.append(host);
  }
  const close = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180);
  };
  const el = h(
    "div",
    { class: `toast${opts.error ? " error" : ""}` },
    h(
      "div",
      { class: "toast-head" },
      h("span", { class: "toast-title" }, title),
      h("button", { class: "icon-btn sm", onclick: close }, icon(X, 14))
    ),
    opts.body && h("div", { class: "toast-body" }, opts.body),
    opts.action &&
      h(
        "button",
        {
          class: "btn btn-secondary btn-block",
          onclick: () => {
            opts.action!.run();
            close();
          },
        },
        opts.action.label
      )
  );
  host.append(el);
  setTimeout(close, opts.error ? 9000 : 5000);
}

// ---- popover menus (speed picker, recents "...", right-click menus)

export type MenuItem =
  | {
      label: string;
      hint?: string;
      icon?: IconNode;
      checked?: boolean;
      danger?: boolean;
      /** shown but greyed out, so it's clear the action exists */
      disabled?: boolean;
      run?: () => void;
      /** a submenu that opens on hover */
      items?: MenuItem[];
    }
  | { section: string }
  | "sep"
  | null
  | false;

type Entry = Exclude<MenuItem, null | false | "sep" | { section: string }>;

const MAX_DEPTH = 3; // menu, submenu, sub-submenu: deeper just gets bloated

/** One open panel: the menu itself or a submenu hanging off one of its items. */
type Panel = {
  el: HTMLElement;
  depth: number;
  child: (Panel & { anchor: HTMLElement; side: "right" | "left" }) | null;
  hovered: HTMLElement | null;
  timer: number;
};

let openMenu: (() => void) | null = null;
let openAnchor: HTMLElement | null = null;

export function closeMenu() {
  openMenu?.();
}

// drop empty sections and doubled-up separators left by conditional items
function tidy(items: MenuItem[]) {
  const list = items.filter(Boolean) as Exclude<MenuItem, null | false>[];
  return list.filter((item, i) => {
    const next = list[i + 1];
    if (item === "sep")
      return i > 0 && next != null && next !== "sep" && list[i - 1] !== "sep";
    if (typeof item === "object" && "section" in item)
      return (
        next != null &&
        next !== "sep" &&
        !(typeof next === "object" && "section" in next)
      );
    return true;
  });
}

const hasSub = (item: Entry) =>
  !!item.items?.some(x => x && x !== "sep" && !("section" in x));

/** Is point p inside the triangle abc? */
function inTriangle(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
) {
  const s = (p1: typeof p, p2: typeof p, p3: typeof p) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Opens under (or above) `anchor`, or at a point for right-click menus. */
export function menu(
  anchor: HTMLElement | { x: number; y: number },
  items: MenuItem[],
  opts: { align?: "start" | "end"; above?: boolean } = {}
) {
  // clicking the button of an open menu closes it instead of opening it again
  if (anchor instanceof HTMLElement && anchor === openAnchor) {
    closeMenu();
    return;
  }
  closeMenu();
  const point = !(anchor instanceof HTMLElement);
  // every panel lives in here, so "clicked outside" means outside all of them
  const layer = h("div", { class: "menu-layer" });
  const runners: (() => void)[] = [];
  // the last few pointer positions, to tell whether it's heading into a submenu
  const trail: { x: number; y: number }[] = [];

  /** Moving from where the pointer was toward the submenu's near edge? (the "safe triangle") */
  const aiming = (p: Panel) => {
    const c = p.child;
    if (!c || trail.length < 2) return false;
    const from = trail[0];
    const now = trail[trail.length - 1];
    if (from.x === now.x && from.y === now.y) return false;
    const r = c.el.getBoundingClientRect();
    const x = c.side === "right" ? r.left : r.right;
    return inTriangle(now, from, { x, y: r.top - 12 }, { x, y: r.bottom + 12 });
  };

  const closeChild = (p: Panel) => {
    if (!p.child) return;
    closeChild(p.child);
    clearTimeout(p.child.timer);
    p.child.anchor.classList.remove("sub-open");
    p.child.el.remove();
    p.child = null;
  };

  const openChild = (p: Panel, btn: HTMLElement, sub: MenuItem[]) => {
    closeChild(p);
    const el = build(sub, p.depth + 1);
    el.classList.add("submenu");
    layer.append(el);
    // measured without transforms: panels are still scaling in while this runs
    const pl = parseFloat(p.el.style.left);
    const pr = { left: pl, right: pl + p.el.offsetWidth };
    const bTop = parseFloat(p.el.style.top) + btn.offsetTop;
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    // to the right if it fits, otherwise to the left; a little overlap so the gap isn't a dead zone
    const side = pr.right + mw + 8 <= innerWidth ? "right" : "left";
    const left = side === "right" ? pr.right - 4 : pr.left - mw + 4;
    const top = Math.min(Math.max(8, bTop - 6), innerHeight - mh - 8);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = `${side === "right" ? "left" : "right"} ${bTop - top + btn.offsetHeight / 2}px`;
    btn.classList.add("sub-open");
    p.child = {
      el,
      depth: p.depth + 1,
      child: null,
      hovered: null,
      timer: 0,
      anchor: btn,
      side,
    };
    panels.set(el, p.child);
    return p.child;
  };

  /** The pointer landed on an item: open its submenu, close a sibling's, or wait if it's on its way into one. */
  const hover = (p: Panel, btn: HTMLElement, item: Entry, now = false) => {
    p.hovered = btn;
    clearTimeout(p.timer);
    if (p.child?.anchor === btn) return;
    if (!now && p.child && aiming(p)) {
      // passing over on the way to the open submenu: check again once the pointer settles
      p.timer = window.setTimeout(() => {
        if (p.hovered === btn) hover(p, btn, item, true);
      }, 220);
      return;
    }
    closeChild(p);
    if (hasSub(item) && !item.disabled && p.depth < MAX_DEPTH)
      openChild(p, btn, item.items!);
  };

  const panels = new Map<HTMLElement, Panel>();

  function build(list: MenuItem[], depth: number) {
    const el = h("div", { class: `menu depth-${depth}`, role: "menu" });
    for (const item of tidy(list)) {
      if (item === "sep") el.append(h("div", { class: "menu-sep" }));
      else if ("section" in item)
        el.append(h("div", { class: "menu-section" }, item.section));
      else {
        const sub = hasSub(item) && depth < MAX_DEPTH;
        const btn = h(
          "button",
          {
            class: `menu-item${item.danger ? " danger" : ""}${sub ? " has-sub" : ""}`,
            disabled: item.disabled,
            role: "menuitem",
          },
          item.icon ? icon(item.icon, 16) : null,
          h("span", { class: "menu-label" }, item.label),
          item.checked
            ? h("span", { class: "menu-check" }, icon(Check, 16, 2))
            : null,
          item.hint ? h("span", { class: "menu-hint" }, item.hint) : null,
          sub
            ? h("span", { class: "menu-chev" }, icon(ChevronRight, 14, 2))
            : null
        );
        const panel = () => panels.get(el)!;
        const run = () => {
          if (item.disabled) return;
          if (sub) {
            hover(panel(), btn, item, true);
            return;
          }
          closeMenu();
          item.run?.();
        };
        btn.addEventListener("click", run);
        btn.addEventListener("pointerenter", () => hover(panel(), btn, item));
        // still on the same item and no longer heading for the submenu: switch now
        btn.addEventListener("pointermove", () => {
          const p = panel();
          if (
            p.hovered === btn &&
            p.child &&
            p.child.anchor !== btn &&
            !aiming(p)
          )
            hover(p, btn, item, true);
        });
        if (depth === 1 && !item.disabled && !sub) runners.push(run);
        el.append(btn);
      }
    }
    // reaching a submenu keeps it open, even if a sibling item was crossed on the way
    el.addEventListener("pointerenter", () => {
      for (const p of panels.values())
        if (p.child?.el === el) {
          clearTimeout(p.timer);
          p.hovered = p.child.anchor;
        }
    });
    return el;
  }

  const root = build(items, 1);
  const top: Panel = {
    el: root,
    depth: 1,
    child: null,
    hovered: null,
    timer: 0,
  };
  panels.set(root, top);
  layer.append(root);
  document.body.append(layer);
  const mr = { width: root.offsetWidth, height: root.offsetHeight };
  if (!(anchor instanceof HTMLElement)) {
    // right-click: open at the pointer, flipping left/up when it would run off screen
    const left =
      anchor.x + mr.width + 8 > innerWidth ? anchor.x - mr.width : anchor.x;
    const y =
      anchor.y + mr.height + 8 > innerHeight ? anchor.y - mr.height : anchor.y;
    root.style.left = `${Math.min(Math.max(8, left), innerWidth - mr.width - 8)}px`;
    root.style.top = `${Math.min(Math.max(8, y), innerHeight - mr.height - 8)}px`;
    root.classList.add("context");
  } else {
    const r = anchor.getBoundingClientRect();
    const above = opts.above ?? r.bottom + mr.height + 8 > innerHeight;
    const left = opts.align === "end" ? r.right - mr.width : r.left;
    root.style.left = `${Math.min(Math.max(8, left), innerWidth - mr.width - 8)}px`;
    root.style.top = `${above ? r.top - mr.height - 6 : r.bottom + 6}px`;
    anchor.classList.add("open");
  }

  const onMove = (e: PointerEvent) => {
    trail.push({ x: e.clientX, y: e.clientY });
    if (trail.length > 4) trail.shift();
    // where the pointer is relative to each panel, and how close: themes can light the edge with it
    for (const el of layer.querySelectorAll<HTMLElement>(".menu")) {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
      el.style.setProperty(
        "--near",
        String(Math.max(0, 1 - Math.hypot(dx, dy) / 120).toFixed(3))
      );
    }
  };
  const onDown = (e: PointerEvent) => {
    if (
      !layer.contains(e.target as Node) &&
      (point || !(anchor as HTMLElement).contains(e.target as Node))
    )
      closeMenu();
  };
  // another right-click elsewhere replaces this menu instead of stacking
  const onContext = (e: MouseEvent) => {
    if (!layer.contains(e.target as Node)) closeMenu();
  };
  /** The deepest panel holding focus (or the top one). */
  const focusedPanel = () => {
    const btn = document.activeElement as HTMLElement | null;
    const el = btn?.closest<HTMLElement>(".menu");
    return (el && panels.get(el)) || top;
  };
  const onKey = (e: KeyboardEvent) => {
    const p = focusedPanel();
    const btns = [
      ...p.el.querySelectorAll<HTMLButtonElement>(
        ":scope > button:not(:disabled)"
      ),
    ];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.stopPropagation();
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? (i + 1) % btns.length
          : i < 0
            ? btns.length - 1
            : (i - 1 + btns.length) % btns.length;
      btns[next]?.focus();
    } else if (
      e.key === "ArrowRight" &&
      btns[i]?.classList.contains("has-sub")
    ) {
      e.preventDefault();
      btns[i].click();
      p.child?.el
        .querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    } else if (e.key === "ArrowLeft" && p !== top) {
      e.preventDefault();
      for (const parent of panels.values())
        if (parent.child === p) {
          const back = parent.child.anchor;
          closeChild(parent);
          back.focus();
        }
    } else if (/^[1-9]$/.test(e.key) && p === top && runners[+e.key - 1]) {
      e.stopPropagation();
      e.preventDefault();
      runners[+e.key - 1]();
    }
  };
  // added a tick later so the click or right-click that opened the menu doesn't close it again
  const listen = setTimeout(() => {
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("contextmenu", onContext);
  }, 0);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu);
  openAnchor = anchor instanceof HTMLElement ? anchor : null;
  openMenu = () => {
    openMenu = null;
    openAnchor = null;
    clearTimeout(listen);
    for (const p of panels.values()) clearTimeout(p.timer);
    if (anchor instanceof HTMLElement) anchor.classList.remove("open");
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("contextmenu", onContext);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", closeMenu);
    layer.remove();
  };
}

export const menuOpen = () => openMenu != null;

// ---- modal dialogs

let modalCount = 0;
export const modalOpen = () => modalCount > 0;

export function modal(
  title: string,
  body: Node,
  opts: { wide?: boolean; onClose?: () => boolean | void } = {}
) {
  const close = () => {
    if (opts.onClose?.() === false) return;
    modalCount--;
    document.removeEventListener("keydown", onKey, true);
    backdrop.classList.add("leaving");
    setTimeout(() => backdrop.remove(), 150);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !menuOpen()) {
      e.stopPropagation();
      close();
    }
  };
  const card = h(
    "div",
    { class: `modal${opts.wide ? " wide" : ""}`, role: "dialog" },
    h(
      "div",
      { class: "modal-head" },
      h("h2", {}, title),
      h("button", { class: "icon-btn", onclick: close }, icon(X, 18))
    ),
    body
  );
  const backdrop = h(
    "div",
    {
      class: "backdrop",
      onpointerdown: (e: PointerEvent) => {
        if (e.target === backdrop) close();
      },
    },
    card
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  modalCount++;
  return { close, card };
}
