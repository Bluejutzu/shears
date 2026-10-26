import {
  ChevronLeft,
  Download,
  LayoutGrid,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
  type IconNode,
} from "lucide";

import { store } from "../shared/settings";
import {
  h,
  icon,
  menu,
  menuOpen,
  modalOpen,
  stem,
  toast,
  type MenuItem,
} from "../shared/ui";
import { tipBtn } from "./bits";
import { convertAdd, renderConvert } from "./convert";
import {
  closeEditor,
  importFiles,
  newDialog,
  openBlob,
  openFileAsNew,
  openItem,
  save,
  whenSaved,
} from "./create";
import { fileToDataUrl, renderDoc, toPng } from "./doc";
import { renderEditor, TOOLS } from "./editor-view";
import { exportDialog, IMAGE_FILTER } from "./export";
import { flowPreselect, renderFlow } from "./flow";
import {
  allItems,
  categories,
  filtered,
  loadLibrary,
  onLibrary,
} from "./library";
import {
  confirmDelete,
  drawGrid,
  removeCategory,
  renameCategory,
  renderLibrary,
} from "./library-view";
import { host, redraw, setHost, st, type ImagesHost, type View } from "./state";

import "./images.css";

export { pickFromLibrary, type Placement } from "./flow";
export type { ImagesHost } from "./state";

const $ = (id: string) => document.getElementById(id)!;
const fileName = (p: string) => p.split(/[\\/]/).pop()!;

/** Everything the keyboard can do here, for the shortcuts list in Settings. */
export const imageShortcuts = () => [
  ...TOOLS.map(t => ({ group: "Image tools", label: t.label, keys: [t.key] })),
  { group: "Image editor", label: "New image", keys: ["Ctrl N"] },
  { group: "Image editor", label: "Open a picture file", keys: ["Ctrl O"] },
  { group: "Image editor", label: "Save to the library", keys: ["Ctrl S"] },
  { group: "Image editor", label: "Export…", keys: ["Ctrl E"] },
  { group: "Image editor", label: "Copy the picture", keys: ["Ctrl Shift C"] },
  { group: "Image editor", label: "Undo", keys: ["Ctrl Z"] },
  { group: "Image editor", label: "Redo", keys: ["Ctrl Shift Z", "Ctrl Y"] },
  {
    group: "Image editor",
    label: "Copy / paste layers or pictures",
    keys: ["Ctrl C", "Ctrl V"],
  },
  { group: "Image editor", label: "Duplicate", keys: ["Ctrl D"] },
  { group: "Image editor", label: "Delete", keys: ["Del"] },
  { group: "Image editor", label: "Select all", keys: ["Ctrl A"] },
  {
    group: "Image editor",
    label: "Nudge (Shift for 10 px)",
    keys: ["←", "→", "↑", "↓"],
  },
  { group: "Image editor", label: "Forward / backward", keys: ["]", "["] },
  {
    group: "Image editor",
    label: "To front / to back",
    keys: ["Ctrl ]", "Ctrl ["],
  },
  { group: "Image editor", label: "Edit text", keys: ["Enter"] },
  { group: "Image editor", label: "Zoom to fit", keys: ["Ctrl 0"] },
  { group: "Image editor", label: "Zoom to 100%", keys: ["1"] },
  { group: "Image editor", label: "Zoom in / out", keys: ["Ctrl +", "Ctrl -"] },
  { group: "Image editor", label: "Pan", keys: ["Space"] },
  { group: "Image library", label: "Search", keys: ["/"] },
  { group: "Image library", label: "Select all", keys: ["Ctrl A"] },
  { group: "Image library", label: "Delete selected", keys: ["Del"] },
  { group: "Image library", label: "Clear selection", keys: ["Esc"] },
];

export function initImages(h0: ImagesHost) {
  setHost(h0);
  redraw.all = () => (drawSidebar(), drawMain(), drawChrome());
  redraw.sidebar = drawSidebar;
  redraw.main = drawMain;
  redraw.chrome = drawChrome;
  redraw.go = go;
  onLibrary(() => {
    if (!st.active) return;
    drawSidebar();
    if (st.view === "library") drawGrid();
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("paste", onPaste);
  loadLibrary();
}

export function enterImages() {
  st.active = true;
  st.filter.sort = store.settings.images.sort;
  loadLibrary();
  redraw.all();
}

export function leaveImages() {
  st.active = false;
}

/** Show a page. Leaving the editor goes through the save check first. */
function go(view: View) {
  const swap = () => {
    if (view !== "editor") closeEditor();
    st.view = view;
    redraw.all();
  };
  if (st.view === "editor" && view !== "editor") whenSaved(swap);
  else swap();
}

/** Open the send-to-video page, with these library images already picked. */
export function sendToVideo(ids: string[] = []) {
  flowPreselect(ids);
  go("send");
}

export function imageDrop(paths: string[]) {
  const pics = paths.filter(p =>
    IMAGE_FILTER.extensions.includes(p.split(".").pop()!.toLowerCase())
  );
  if (!pics.length) return;
  const ed = st.view === "editor" ? st.editor : null;
  if (ed)
    (async () => {
      for (const p of pics)
        await ed.addPicture(await fileToDataUrl(p), stem(p));
    })();
  else if (st.view === "convert")
    convertAdd(pics.map(path => ({ path, name: fileName(path) })));
  else importFiles(pics);
}

// ---- sidebar

function drawSidebar() {
  const all = allItems();
  const cats = categories();
  const uncategorized = all.filter(i => !i.category).length;
  const f = st.filter;

  const navItem = (view: View, label: string, ic: IconNode) =>
    h(
      "button",
      {
        class: `nav-item${st.view === view ? " active" : ""}`,
        onclick: () => go(view),
      },
      icon(ic, 18),
      h("span", {}, label)
    );

  const cat = (
    label: string,
    value: string | null,
    count: number,
    items: MenuItem[] = []
  ) =>
    h(
      "button",
      {
        class: `img-cat${st.view === "library" && f.category === value ? " active" : ""}`,
        onclick: () => {
          f.category = value;
          st.picked.clear();
          go("library");
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (items.length) menu({ x: e.clientX, y: e.clientY }, items);
        },
      },
      h("span", { class: "img-cat-name" }, label),
      h("span", { class: "media-count" }, String(count))
    );

  $("image-sidebar").replaceChildren(
    h(
      "nav",
      { class: "nav" },
      h(
        "button",
        { class: "nav-item primary", onclick: newDialog },
        icon(Plus, 18),
        h("span", {}, "New image")
      ),
      navItem("library", "Library", LayoutGrid),
      navItem("convert", "Convert", RefreshCw),
      navItem("send", "Send to video", Send)
    ),
    h("div", { class: "media-head" }, h("span", {}, "Categories")),
    h(
      "div",
      { class: "media-scroll img-cats" },
      cat("All images", null, all.length),
      ...cats.map(([name, n]) =>
        cat(name, name, n, [
          {
            label: "Rename category…",
            icon: Pencil,
            run: () => renameCategory(name),
          },
          {
            label: "Remove category",
            icon: Trash2,
            danger: true,
            run: () => removeCategory(name),
          },
        ])
      ),
      ...(uncategorized && cats.length
        ? [cat("Uncategorized", "", uncategorized)]
        : []),
      cats.length
        ? null
        : h(
            "div",
            { class: "img-cats-hint dim small" },
            "Give images a category to group them here."
          )
    ),
    host().footer()
  );
}

// ---- titlebar

function drawChrome() {
  const ed = st.view === "editor" ? st.editor : null;
  // pages carry their own big heading, so the titlebar only names an open picture
  $("img-title").textContent = ed
    ? `${st.cur.name}${ed.dirty ? " •" : ""}`
    : "";
  $("img-actions").replaceChildren(
    ...(ed
      ? [
          h(
            "button",
            { class: "btn btn-ghost btn-sm", onclick: () => go("library") },
            icon(ChevronLeft, 15),
            "Library"
          ),
          h("div", { class: "tb-sep" }),
          tipBtn(Undo2, "Undo", () => ed.undo(), {
            key: "Ctrl Z",
            off: !ed.canUndo,
            below: true,
          }),
          tipBtn(Redo2, "Redo", () => ed.redo(), {
            key: "Ctrl Shift Z",
            off: !ed.canRedo,
            below: true,
          }),
          h("div", { class: "tb-sep" }),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: async () => {
                if (!(await save()) || !st.cur.id) return;
                sendToVideo([st.cur.id]);
              },
            },
            icon(Send, 14),
            "Send to video"
          ),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: () => exportDialog(ed, st.cur.name),
            },
            icon(Download, 14),
            "Export"
          ),
          h(
            "button",
            { class: "btn btn-primary btn-sm", onclick: () => void save() },
            "Save"
          ),
        ]
      : [])
  );
}

// ---- pages

function drawMain() {
  const root = $("image-main");
  if (st.view === "editor" && st.editor) renderEditor(root);
  else if (st.view === "convert") renderConvert(root);
  else if (st.view === "send") renderFlow(root, host());
  else {
    st.view = "library";
    renderLibrary(root);
  }
}

// ---- keyboard and paste

function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return (
    (el instanceof HTMLInputElement &&
      el.type !== "range" &&
      el.type !== "color") ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    !!el?.isContentEditable
  );
}

const stop = (e: KeyboardEvent, run: () => void) => {
  e.preventDefault();
  run();
};

function onKey(e: KeyboardEvent) {
  if (!st.active || modalOpen() || menuOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (typing(e.target)) {
    if (k === "escape") (e.target as HTMLElement).blur();
    return;
  }
  if (mod && k === "n") return stop(e, newDialog);
  if (mod && k === "o") return stop(e, () => openFileAsNew());
  const ed = st.view === "editor" ? st.editor : null;
  if (!ed) {
    if (st.view !== "library") return;
    const p = st.picked;
    if (k === "/")
      return stop(e, () => document.getElementById("img-search")?.focus());
    if (mod && k === "a")
      return stop(
        e,
        () => (filtered(st.filter).forEach(i => p.add(i.id)), drawGrid())
      );
    if (k === "escape" && p.size) return stop(e, () => (p.clear(), drawGrid()));
    if ((k === "delete" || k === "backspace") && p.size)
      return stop(e, () => confirmDelete([...p]));
    if (k === "enter" && p.size === 1)
      return stop(e, () => openItem([...p][0]));
    return;
  }
  if (mod && k === "s") return stop(e, () => void save());
  if (mod && k === "e") return stop(e, () => exportDialog(ed, st.cur.name));
  if (mod && e.shiftKey && k === "c") return stop(e, () => void copyPicture());
  if (ed.key(e)) {
    e.preventDefault();
    drawChrome();
  }
}

async function copyPicture() {
  if (!st.editor) return;
  try {
    const blob = await toPng(await renderDoc(st.editor.doc));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Picture copied");
  } catch (err) {
    toast("Couldn't copy the picture", { body: String(err), error: true });
  }
}

function onPaste(e: ClipboardEvent) {
  if (!st.active || modalOpen() || typing(e.target)) return;
  const file = [...(e.clipboardData?.files ?? [])].find(f =>
    f.type.startsWith("image/")
  );
  const ed = st.view === "editor" ? st.editor : null;
  if (file) {
    e.preventDefault();
    if (ed) ed.addBlob(file, "Pasted image");
    else openBlob(file);
    return;
  }
  if (ed?.pasteLayers()) e.preventDefault();
}
