import { Check, X, createElement, type IconNode } from "lucide";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function icon(node: IconNode, size = 16, strokeWidth = 1.75) {
  return createElement(node, { width: size, height: size, "stroke-width": strokeWidth, class: "icon" });
}

export function fmt(t: number, precise = true) {
  if (!isFinite(t)) t = 0;
  const neg = t < 0;
  t = Math.abs(t);
  const hrs = Math.floor(t / 3600);
  const min = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const s = precise ? sec.toFixed(2).padStart(5, "0") : String(Math.floor(sec)).padStart(2, "0");
  const body = hrs ? `${hrs}:${String(min).padStart(2, "0")}:${s}` : `${min}:${s}`;
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
export const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
export const stem = (p: string) => basename(p).replace(/\.[^.]+$/, "");
export const join = (dir: string, name: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;
export const ext = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? "").toLowerCase();

export function kbd(combo: string) {
  return h(
    "span",
    { class: "kbd-group" },
    ...combo.split(" ").map((k) => h("kbd", {}, k)),
  );
}

// ---- tooltips: any element with data-tip gets a little dark pill on hover

let tipEl: HTMLElement | null = null;
let tipTimer = 0;

export function initTooltips() {
  tipEl = h("div", { class: "tooltip" });
  document.body.append(tipEl);
  document.addEventListener("pointerover", (e) => {
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
      const left = Math.min(Math.max(8, r.left + r.width / 2 - tr.width / 2), innerWidth - tr.width - 8);
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

export function toast(title: string, opts: { body?: string; action?: { label: string; run: () => void }; error?: boolean } = {}) {
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
      h("button", { class: "icon-btn sm", onclick: close }, icon(X, 14)),
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
        opts.action.label,
      ),
  );
  host.append(el);
  setTimeout(close, opts.error ? 9000 : 5000);
}

// ---- popover menus (speed picker, recents "...")

export type MenuItem =
  | { label: string; hint?: string; icon?: IconNode; checked?: boolean; danger?: boolean; run: () => void }
  | { section: string }
  | "sep";

let openMenu: (() => void) | null = null;

export function closeMenu() {
  openMenu?.();
}

export function menu(anchor: HTMLElement, items: MenuItem[], opts: { align?: "start" | "end"; above?: boolean } = {}) {
  closeMenu();
  const el = h("div", { class: "menu", role: "menu" });
  const runners: (() => void)[] = [];
  for (const item of items) {
    if (item === "sep") el.append(h("div", { class: "menu-sep" }));
    else if ("section" in item) el.append(h("div", { class: "menu-section" }, item.section));
    else {
      const run = () => {
        closeMenu();
        item.run();
      };
      runners.push(run);
      el.append(
        h(
          "button",
          { class: `menu-item${item.danger ? " danger" : ""}`, onclick: run },
          item.icon ? icon(item.icon, 16) : null,
          h("span", { class: "menu-label" }, item.label),
          item.checked ? h("span", { class: "menu-check" }, icon(Check, 16, 2)) : null,
          item.hint ? h("span", { class: "menu-hint" }, item.hint) : null,
        ),
      );
    }
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mr = el.getBoundingClientRect();
  const above = opts.above ?? r.bottom + mr.height + 8 > innerHeight;
  const left = opts.align === "end" ? r.right - mr.width : r.left;
  el.style.left = `${Math.min(Math.max(8, left), innerWidth - mr.width - 8)}px`;
  el.style.top = `${above ? r.top - mr.height - 6 : r.bottom + 6}px`;
  anchor.classList.add("open");

  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
    } else if (/^[1-9]$/.test(e.key) && runners[+e.key - 1]) {
      e.stopPropagation();
      e.preventDefault();
      runners[+e.key - 1]();
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
  document.addEventListener("keydown", onKey, true);
  openMenu = () => {
    openMenu = null;
    anchor.classList.remove("open");
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("keydown", onKey, true);
    el.remove();
  };
}

export const menuOpen = () => openMenu != null;

// ---- modal dialogs

let modalCount = 0;
export const modalOpen = () => modalCount > 0;

export function modal(title: string, body: Node, opts: { wide?: boolean; onClose?: () => boolean | void } = {}) {
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
    h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "icon-btn", onclick: close }, icon(X, 18))),
    body,
  );
  const backdrop = h(
    "div",
    {
      class: "backdrop",
      onpointerdown: (e: PointerEvent) => {
        if (e.target === backdrop) close();
      },
    },
    card,
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  modalCount++;
  return { close, card };
}
