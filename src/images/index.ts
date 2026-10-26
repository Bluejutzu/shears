import { open } from "@tauri-apps/plugin-dialog";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronsDown,
  ChevronsUp,
  Circle,
  Copy,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Keyboard,
  Lock,
  LockOpen,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  Square,
  Trash2,
  Triangle,
  Type,
  Undo2,
  Upload,
  type IconNode,
} from "lucide";

import { api } from "../api";
import { openMetadata } from "../metadata";
import { saveSettings, store } from "../settings";
import {
  basename,
  h,
  icon,
  menu,
  menuOpen,
  modal,
  modalOpen,
  row,
  segmented,
  stem,
  toast,
  toggle,
  type MenuItem,
} from "../ui";
import {
  blobToDataUrl,
  fileToDataUrl,
  FONTS,
  loadPicture,
  newLayer,
  renderDoc,
  SIZES,
  toPng,
  type Doc,
  type Layer,
} from "./doc";
import { ImageEditor, type Tool } from "./editor";
import { convertDialog, exportDialog, IMAGE_FILTER } from "./export";
import {
  allItems,
  categories,
  filtered,
  itemById,
  loadLibrary,
  newItemId,
  onLibrary,
  pathOf,
  removeItems,
  saveItem,
  thumbUrl,
  updateItems,
  type Filter,
  type ImageItem,
} from "./library";
import { BACKGROUNDS, blankDoc, TEMPLATES } from "./templates";

import "./images.css";

export type ImagesHost = {
  modeSwitch: () => HTMLElement;
  /** videos that can take images, the open one first */
  videos: () => { path: string; name: string; current: boolean }[];
  browseVideo: () => Promise<string | null>;
  send: (paths: string[], video: string, seconds: number) => Promise<void>;
  showSettings: () => void;
  showShortcuts: () => void;
};

const $ = (id: string) => document.getElementById(id)!;
let host: ImagesHost;
let active = false;
let editor: ImageEditor | null = null;
let cur = {
  id: null as string | null,
  name: "Untitled",
  category: "",
  tags: [] as string[],
};
const filter: Filter = { q: "", category: null, sort: "new" };
const picked = new Set<string>();
let lastPicked: string | null = null;
let panelFrame = 0;

const els = {
  sidebar: () => $("image-sidebar"),
  main: () => $("image-main"),
  title: () => $("img-title"),
  actions: () => $("img-actions"),
};

const TOOLS: { tool: Tool; label: string; key: string; icon: IconNode }[] = [
  { tool: "select", label: "Select", key: "V", icon: MousePointer2 },
  { tool: "rect", label: "Rectangle", key: "R", icon: Square },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { tool: "triangle", label: "Triangle", key: "Y", icon: Triangle },
  { tool: "line", label: "Line", key: "L", icon: Minus },
  { tool: "arrow", label: "Arrow", key: "A", icon: MoveUpRight },
  { tool: "pen", label: "Pen", key: "P", icon: Pencil },
  { tool: "text", label: "Text", key: "T", icon: Type },
];

/** Everything the keyboard can do here, for the shortcuts list in Settings. */
export const imageShortcuts = () => [
  ...TOOLS.map(t => ({ group: "Image tools", label: t.label, keys: [t.key] })),
  { group: "Image editor", label: "New image", keys: ["Ctrl N"] },
  { group: "Image editor", label: "Open image file", keys: ["Ctrl O"] },
  { group: "Image editor", label: "Save to library", keys: ["Ctrl S"] },
  { group: "Image editor", label: "Export…", keys: ["Ctrl E"] },
  {
    group: "Image editor",
    label: "Copy image to clipboard",
    keys: ["Ctrl Shift C"],
  },
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

// ---- small helpers

const words = () => filter.q.toLowerCase().split(/\s+/).filter(Boolean);

/** Text with the searched words wrapped in <mark>. */
function marked(text: string): (string | Node)[] {
  const w = words();
  if (!w.length) return [text];
  const re = new RegExp(
    w.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi"
  );
  const out: (string | Node)[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index), h("mark", {}, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function ask(
  title: string,
  body: Node,
  ok: string,
  run: () => boolean | void,
  danger = false
) {
  const { close } = modal(
    title,
    h(
      "div",
      { class: "form" },
      body,
      h(
        "div",
        { class: "modal-foot" },
        h(
          "button",
          { class: "btn btn-ghost", onclick: () => close() },
          "Cancel"
        ),
        h(
          "button",
          {
            class: `btn ${danger ? "btn-danger" : "btn-primary"}`,
            onclick: () => {
              if (run() !== false) close();
            },
          },
          ok
        )
      )
    )
  );
}

const iconBtn = (ic: IconNode, tip: string, run: () => void, extra = "") =>
  h(
    "button",
    {
      class: `icon-btn ${extra}`,
      "data-tip": tip,
      "data-tip-pos": "below",
      onclick: run,
    },
    icon(ic, 17)
  );

// ---- setup

export function initImages(h0: ImagesHost) {
  host = h0;
  onLibrary(() => {
    if (!active) return;
    renderSidebar();
    if (!editor) renderMain();
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("paste", onPaste);
  loadLibrary();
}

export function enterImages() {
  active = true;
  filter.sort = store.settings.images.sort;
  loadLibrary();
  renderSidebar();
  renderMain();
  renderChrome();
}

export function leaveImages() {
  active = false;
}

// ---- sidebar

function renderSidebar() {
  const cats = categories();
  const all = allItems();
  const uncategorized = all.filter(i => !i.category).length;
  const catBtn = (
    label: string,
    value: string | null,
    count: number,
    extra: MenuItem[] = []
  ) =>
    h(
      "button",
      {
        class: `img-cat${filter.category === value && !editor ? " active" : ""}`,
        onclick: () => {
          filter.category = value;
          picked.clear();
          showGallery();
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (extra.length) menu({ x: e.clientX, y: e.clientY }, extra);
        },
      },
      h("span", { class: "img-cat-name" }, label),
      h("span", { class: "media-count" }, String(count))
    );

  const search = h("input", {
    class: "input",
    id: "img-search",
    placeholder: "Search images",
    spellcheck: "false",
    value: filter.q,
    oninput: (e: Event) => {
      filter.q = (e.target as HTMLInputElement).value;
      if (editor) showGallery(false);
      else renderMain();
    },
  });

  els.sidebar().replaceChildren(
    host.modeSwitch(),
    h(
      "nav",
      { class: "nav" },
      h(
        "button",
        { class: "nav-item primary", onclick: newDialog },
        icon(Plus, 18),
        h("span", {}, "New image")
      )
    ),
    h("div", { class: "img-search" }, search),
    h(
      "div",
      { class: "media-scroll img-cats" },
      h("div", { class: "img-cats-title" }, "Categories"),
      catBtn("All images", null, all.length),
      ...cats.map(([name, n]) =>
        catBtn(name, name, n, [
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
        ? [catBtn("Uncategorized", "", uncategorized)]
        : [])
    ),
    h(
      "div",
      { class: "img-side-actions" },
      h(
        "button",
        { class: "btn btn-ghost btn-sm", onclick: importDialog },
        icon(Upload, 14),
        "Import"
      ),
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          onclick: async () => {
            const files = await open({
              multiple: true,
              filters: [IMAGE_FILTER],
            });
            if (Array.isArray(files) && files.length)
              convertDialog(
                files.map(path => ({ path, name: basename(path) }))
              );
          },
        },
        icon(RefreshCw, 14),
        "Convert files"
      )
    ),
    h(
      "div",
      { class: "sb-footer" },
      h(
        "div",
        { class: "sb-footer-id" },
        h(
          "div",
          { class: "sb-footer-text" },
          h("div", {}, "Images"),
          h("div", { class: "dim" }, `${all.length} saved`)
        )
      ),
      h(
        "div",
        { class: "sb-footer-actions" },
        iconBtn(Keyboard, "Keyboard shortcuts", () => host.showShortcuts()),
        iconBtn(SettingsIcon, "Settings", () => host.showSettings())
      )
    )
  );
}

function renameCategory(name: string) {
  const input = h("input", {
    class: "input",
    value: name,
    spellcheck: "false",
  });
  ask("Rename category", row("Name", input), "Rename", () => {
    const next = input.value.trim();
    if (!next) return false;
    updateItems(
      allItems()
        .filter(i => i.category === name)
        .map(i => i.id),
      { category: next }
    );
    if (filter.category === name) filter.category = next;
  });
}

function removeCategory(name: string) {
  updateItems(
    allItems()
      .filter(i => i.category === name)
      .map(i => i.id),
    { category: "" }
  );
  if (filter.category === name) filter.category = null;
}

// ---- titlebar

function renderChrome() {
  const ed = editor;
  els.title().textContent = ed
    ? `${cur.name}${ed.dirty ? " •" : ""}`
    : "Image library";
  els.actions().replaceChildren(
    ...(ed
      ? [
          iconBtn(ChevronLeft, "Back to the library", leaveEditor),
          iconBtn(
            Undo2,
            "Undo (Ctrl Z)",
            () => ed.undo(),
            ed.canUndo ? "" : "off"
          ),
          iconBtn(
            Redo2,
            "Redo (Ctrl Shift Z)",
            () => ed.redo(),
            ed.canRedo ? "" : "off"
          ),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: () => sendCurrent(),
            },
            icon(Send, 14),
            "Send to video"
          ),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: () => exportDialog(ed, cur.name),
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

// ---- gallery

function showGallery(redrawSidebar = true) {
  editor?.destroy();
  editor = null;
  if (redrawSidebar) renderSidebar();
  renderMain();
  renderChrome();
}

function renderMain() {
  if (editor) {
    renderEditor();
    return;
  }
  const list = filtered(filter);
  const heading =
    filter.category === null
      ? "All images"
      : filter.category === ""
        ? "Uncategorized"
        : filter.category;
  const any = allItems().length > 0;

  const grid = list.length
    ? h("div", { class: "img-grid" }, ...list.map(card))
    : h(
        "div",
        { class: "img-empty" },
        h("div", { class: "dz-icon" }, icon(ImageIcon, 22)),
        h("h2", {}, any ? "Nothing matches" : "No images yet"),
        h(
          "div",
          { class: "dim" },
          any
            ? "Try other words, or pick another category."
            : "Make one, paste one with Ctrl V, or drop picture files here."
        ),
        any
          ? null
          : h(
              "button",
              { class: "btn btn-primary", onclick: newDialog },
              icon(Plus, 16),
              "New image"
            )
      );

  els.main().replaceChildren(
    h(
      "div",
      { class: "img-gallery" },
      h(
        "div",
        { class: "img-head" },
        h(
          "h1",
          {},
          heading,
          h("span", { class: "media-count" }, String(list.length))
        ),
        h("div", { class: "spacer" }),
        segmented(
          [
            { label: "Newest", value: "new" as const },
            { label: "Name", value: "name" as const },
            { label: "Largest", value: "size" as const },
          ],
          filter.sort,
          v => {
            filter.sort = store.settings.images.sort = v;
            saveSettings();
            renderMain();
          }
        )
      ),
      grid,
      picked.size ? selectionBar() : null
    )
  );
}

function card(i: ImageItem) {
  const on = picked.has(i.id);
  const order = () => filtered(filter).map(x => x.id);
  const toggleOne = (shift: boolean) => {
    if (shift && lastPicked) {
      const ids = order();
      const [a, b] = [ids.indexOf(lastPicked), ids.indexOf(i.id)].sort(
        (x, y) => x - y
      );
      for (const id of ids.slice(a, b + 1)) picked.add(id);
    } else if (picked.has(i.id)) picked.delete(i.id);
    else picked.add(i.id);
    lastPicked = i.id;
    renderMain();
  };
  return h(
    "div",
    {
      class: `img-card${on ? " picked" : ""}`,
      role: "button",
      title: `${i.name} · ${i.w}×${i.h}`,
      onclick: (e: MouseEvent) => {
        if (picked.size || e.ctrlKey || e.shiftKey || e.metaKey)
          toggleOne(e.shiftKey);
        else openItem(i.id);
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        if (!picked.has(i.id)) {
          picked.clear();
          picked.add(i.id);
          lastPicked = i.id;
          renderMain();
        }
        menu({ x: e.clientX, y: e.clientY }, itemMenu([...picked]));
      },
    },
    h(
      "div",
      { class: "img-thumb" },
      h("img", {
        src: thumbUrl(i),
        alt: "",
        loading: "lazy",
        draggable: "false",
      }),
      h(
        "button",
        {
          class: "img-check",
          "aria-label": "Select",
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            toggleOne(e.shiftKey);
          },
        },
        on ? icon(Check, 14, 2.5) : null
      )
    ),
    h(
      "div",
      { class: "img-meta" },
      h("div", { class: "img-name" }, ...marked(i.name)),
      h(
        "div",
        { class: "img-sub" },
        h("span", {}, `${i.w} × ${i.h}`),
        i.category ? h("span", { class: "chip" }, ...marked(i.category)) : null,
        ...i.tags
          .slice(0, 2)
          .map(t => h("span", { class: "img-tag" }, ...marked(t)))
      )
    )
  );
}

function itemMenu(ids: string[]): MenuItem[] {
  const one = ids.length === 1 ? itemById(ids[0]) : undefined;
  const n = ids.length;
  return [
    {
      label: "Open in editor",
      icon: Pencil,
      disabled: n !== 1,
      run: () => openItem(ids[0]),
    },
    {
      label: n > 1 ? `Send ${n} to video…` : "Send to video…",
      icon: Send,
      run: () => sendDialog(ids.map(pathOf)),
    },
    {
      label: "Convert…",
      icon: RefreshCw,
      run: () =>
        convertDialog(
          ids
            .flatMap(id => itemById(id) ?? [])
            .map(i => ({ path: pathOf(i.id), name: `${i.name}.png` }))
        ),
    },
    "sep",
    {
      label: "Name, category and tags…",
      icon: Pencil,
      run: () => detailsDialog(ids),
    },
    !!one && {
      label: "Show file",
      icon: FolderOpen,
      run: () => api.reveal(pathOf(one.id)),
    },
    !!one && {
      label: "Copy path",
      icon: Copy,
      run: () => navigator.clipboard?.writeText(pathOf(one.id)),
    },
    "sep",
    {
      label: n > 1 ? `Delete ${n} images` : "Delete image",
      icon: Trash2,
      danger: true,
      run: () => confirmDelete(ids),
    },
  ];
}

function selectionBar() {
  const ids = [...picked];
  return h(
    "div",
    { class: "img-selbar" },
    h("span", { class: "img-selcount" }, `${ids.length} selected`),
    h(
      "button",
      {
        class: "btn btn-primary btn-sm",
        onclick: () => sendDialog(ids.map(pathOf)),
      },
      icon(Send, 14),
      "Send to video"
    ),
    h(
      "button",
      {
        class: "btn btn-secondary btn-sm",
        onclick: () =>
          convertDialog(
            ids
              .flatMap(id => itemById(id) ?? [])
              .map(i => ({ path: pathOf(i.id), name: `${i.name}.png` }))
          ),
      },
      icon(RefreshCw, 14),
      "Convert"
    ),
    h(
      "button",
      { class: "btn btn-secondary btn-sm", onclick: () => detailsDialog(ids) },
      "Category & tags"
    ),
    h(
      "button",
      { class: "btn btn-ghost btn-sm", onclick: () => confirmDelete(ids) },
      icon(Trash2, 14),
      "Delete"
    ),
    h("div", { class: "spacer" }),
    h(
      "button",
      {
        class: "btn btn-ghost btn-sm",
        onclick: () => {
          picked.clear();
          renderMain();
        },
      },
      "Clear"
    )
  );
}

function confirmDelete(ids: string[]) {
  ask(
    ids.length > 1 ? `Delete ${ids.length} images?` : "Delete this image?",
    h(
      "div",
      { class: "dim" },
      "This removes them from the library for good. A video that already uses one of them will lose that image."
    ),
    "Delete",
    () => {
      picked.clear();
      removeItems(ids);
    },
    true
  );
}

/** One dialog for a single image (name, category, tags) or many (category, extra tags). */
function detailsDialog(ids: string[]) {
  const items = ids.flatMap(id => itemById(id) ?? []);
  if (!items.length) return;
  const one = items.length === 1 ? items[0] : null;
  const name = h("input", {
    class: "input",
    value: one?.name ?? "",
    spellcheck: "false",
  });
  const category = h("input", {
    class: "input",
    list: "img-cat-list",
    value: one ? one.category : "",
    placeholder: one ? "Uncategorized" : "Leave empty to keep each one's own",
    spellcheck: "false",
  });
  const tags = h("input", {
    class: "input",
    value: one ? one.tags.join(", ") : "",
    placeholder: one ? "comma, separated" : "Added to each image",
    spellcheck: "false",
  });
  const list = h(
    "datalist",
    { id: "img-cat-list" },
    ...categories().map(([c]) => h("option", { value: c }))
  );
  ask(
    one ? "Image details" : `${items.length} images`,
    h(
      "div",
      { class: "form" },
      ...(one ? [row("Name", name)] : []),
      row("Category", h("div", {}, category, list)),
      row("Tags", tags)
    ),
    "Save",
    () => {
      const typed = tags.value
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      if (one) {
        updateItems([one.id], {
          name: name.value.trim() || one.name,
          category: category.value.trim(),
          tags: typed,
        });
      } else {
        for (const i of items)
          updateItems([i.id], {
            ...(category.value.trim()
              ? { category: category.value.trim() }
              : {}),
            tags: [...new Set([...i.tags, ...typed])],
          });
      }
    }
  );
}

// ---- opening and creating

async function openItem(id: string) {
  const item = itemById(id);
  if (!item) return;
  const saved = (await api.imageDocRead(id).catch(() => null)) as Doc | null;
  let doc = saved;
  if (!doc?.layers) {
    // saved without its layers: edit the flat picture instead
    const src = await fileToDataUrl(pathOf(id));
    doc = {
      w: item.w,
      h: item.h,
      bg: null,
      layers: [
        newLayer("image", {
          name: item.name,
          src,
          x: item.w / 2,
          y: item.h / 2,
          w: item.w,
          h: item.h,
        }),
      ],
    };
  }
  cur = { id, name: item.name, category: item.category, tags: [...item.tags] };
  startEditor(doc);
}

function startEditor(doc: Doc) {
  editor?.destroy();
  editor = new ImageEditor(doc);
  editor.onChange = () => schedulePanels();
  editor.onTool = () => renderRail();
  renderSidebar();
  renderMain();
  renderChrome();
}

function fresh(doc: Doc, name = "Untitled") {
  cur = { id: null, name, category: filter.category ?? "", tags: [] };
  startEditor(doc);
}

/** A picture as a new document the size of the picture, with its own tags carried along. */
async function docFromSrc(src: string, name: string, path?: string) {
  const img = await loadPicture(src);
  const doc: Doc = {
    w: img.naturalWidth,
    h: img.naturalHeight,
    bg: null,
    layers: [
      newLayer("image", {
        name,
        src,
        x: img.naturalWidth / 2,
        y: img.naturalHeight / 2,
        w: img.naturalWidth,
        h: img.naturalHeight,
      }),
    ],
  };
  if (path) {
    const tags = await api.imageTagsRead(path).catch(() => ({}));
    if (Object.keys(tags).length) doc.meta = { tags, strip: false };
  }
  return doc;
}

async function openFileAsNew(path?: string) {
  const picked_ =
    path ?? (await open({ multiple: false, filters: [IMAGE_FILTER] }));
  if (typeof picked_ !== "string") return;
  try {
    fresh(
      await docFromSrc(await fileToDataUrl(picked_), stem(picked_), picked_),
      stem(picked_)
    );
  } catch {
    toast("Couldn't read that image", { body: basename(picked_), error: true });
  }
}

async function clipboardBlob() {
  try {
    for (const item of await navigator.clipboard.read())
      for (const type of item.types)
        if (type.startsWith("image/")) return await item.getType(type);
  } catch {}
  return null;
}

/** Copy picture files into the library as they are (as PNG), without opening the editor. */
async function importFiles(paths: string[]) {
  let n = 0;
  for (const path of paths) {
    try {
      const doc = await docFromSrc(await fileToDataUrl(path), stem(path), path);
      const png = new Uint8Array(
        await (await toPng(await renderDoc(doc))).arrayBuffer()
      );
      await saveItem(
        {
          id: newItemId(),
          name: stem(path),
          category: filter.category ?? "",
          tags: [],
          w: doc.w,
          h: doc.h,
        },
        png,
        doc
      );
      n++;
    } catch {}
  }
  toast(
    n
      ? `Imported ${n} ${n === 1 ? "image" : "images"}`
      : "Couldn't read those files",
    { error: !n }
  );
}

async function importDialog() {
  const files = await open({ multiple: true, filters: [IMAGE_FILTER] });
  if (Array.isArray(files) && files.length) importFiles(files);
}

export function imageDrop(paths: string[]) {
  const pics = paths.filter(p =>
    IMAGE_FILTER.extensions.includes(p.split(".").pop()!.toLowerCase())
  );
  if (!pics.length) return;
  if (editor)
    (async () => {
      for (const p of pics)
        await editor!.addPicture(await fileToDataUrl(p), stem(p));
    })();
  else importFiles(pics);
}

function newDialog() {
  const p = store.settings.images;
  let size = p.size in SIZES ? p.size : "video";
  let bg = BACKGROUNDS.find(b => b.bg === p.bg) ?? BACKGROUNDS[0];
  let template = "blank";
  let customW = SIZES[size].w;
  let customH = SIZES[size].h;
  const body = h("div", { class: "form" });
  const { close } = modal("New image", body, { wide: true });

  const swatch = (b: (typeof BACKGROUNDS)[number]) => {
    const style =
      b.bg === null
        ? ""
        : typeof b.bg === "string"
          ? `background:${b.bg}`
          : `background:linear-gradient(135deg, ${b.bg.from}, ${b.bg.to})`;
    return h("button", {
      class: `swatch${b === bg ? " active" : ""}${b.bg === null ? " clear" : ""}`,
      style,
      title: b.label,
      onclick: () => ((bg = b), render()),
    });
  };

  const render = () => {
    const blank = template === "blank";
    body.replaceChildren(
      h(
        "div",
        { class: "tpl-grid" },
        ...TEMPLATES.map(t =>
          h(
            "button",
            {
              class: `tpl${t.id === template ? " active" : ""}`,
              onclick: () => ((template = t.id), render()),
            },
            h("div", { class: "tpl-name" }, t.label),
            h("div", { class: "tpl-hint" }, t.hint)
          )
        )
      ),
      ...(blank
        ? [
            row(
              "Size",
              h(
                "div",
                {},
                segmented(
                  Object.entries(SIZES).map(([value, v]) => ({
                    label: v.label,
                    value,
                  })),
                  size,
                  v => {
                    size = v;
                    customW = SIZES[v].w;
                    customH = SIZES[v].h;
                    render();
                  }
                ),
                h(
                  "div",
                  { class: "inline", style: "margin-top:8px" },
                  h("input", {
                    class: "input input-sm",
                    type: "number",
                    min: "16",
                    max: "8192",
                    value: String(customW),
                    onchange: (e: Event) =>
                      (customW =
                        +(e.target as HTMLInputElement).value || customW),
                  }),
                  h("span", { class: "dim" }, "×"),
                  h("input", {
                    class: "input input-sm",
                    type: "number",
                    min: "16",
                    max: "8192",
                    value: String(customH),
                    onchange: (e: Event) =>
                      (customH =
                        +(e.target as HTMLInputElement).value || customH),
                  }),
                  h("span", { class: "dim small" }, "px")
                )
              )
            ),
            row(
              "Background",
              h(
                "div",
                { class: "swatches" },
                ...BACKGROUNDS.map(swatch),
                h("input", {
                  class: "color-input",
                  type: "color",
                  title: "Pick a color",
                  value: typeof bg.bg === "string" ? bg.bg : "#ffffff",
                  oninput: (e: Event) =>
                    (bg = {
                      label: "Custom",
                      bg: (e.target as HTMLInputElement).value,
                    }),
                })
              )
            ),
          ]
        : [
            h(
              "div",
              { class: "dim small" },
              "Starter layouts are made for a 1920 × 1080 frame. Everything on them can be changed."
            ),
          ]),
      h(
        "div",
        { class: "modal-foot split" },
        h(
          "div",
          { class: "inline" },
          h(
            "button",
            {
              class: "btn btn-secondary",
              onclick: () => (close(), openFileAsNew()),
            },
            icon(Upload, 14),
            "From a file…"
          ),
          h(
            "button",
            {
              class: "btn btn-secondary",
              onclick: async () => {
                const blob = await clipboardBlob();
                if (!blob) return toast("No picture on the clipboard");
                close();
                fresh(
                  await docFromSrc(await blobToDataUrl(blob), "Pasted image"),
                  "Pasted image"
                );
              },
            },
            icon(Copy, 14),
            "From clipboard"
          )
        ),
        h(
          "div",
          { class: "inline" },
          h(
            "button",
            { class: "btn btn-ghost", onclick: () => close() },
            "Cancel"
          ),
          h(
            "button",
            {
              class: "btn btn-primary",
              onclick: () => {
                close();
                if (!blank) {
                  const t = TEMPLATES.find(x => x.id === template)!;
                  fresh(t.make(), t.label);
                } else {
                  const d = blankDoc(size, bg.bg);
                  d.w = Math.min(8192, Math.max(16, Math.round(customW)));
                  d.h = Math.min(8192, Math.max(16, Math.round(customH)));
                  fresh(d);
                }
              },
            },
            "Create"
          )
        )
      )
    );
  };
  render();
}

// ---- saving, leaving, sending

async function save() {
  const ed = editor;
  if (!ed) return false;
  ed.commitText();
  try {
    const png = new Uint8Array(
      await (await toPng(await renderDoc(ed.doc))).arrayBuffer()
    );
    const id = cur.id ?? newItemId();
    await saveItem(
      {
        id,
        name: cur.name,
        category: cur.category,
        tags: cur.tags,
        w: ed.doc.w,
        h: ed.doc.h,
      },
      png,
      ed.doc
    );
    cur.id = id;
    ed.markSaved();
    renderChrome();
    toast("Saved to the library", { body: cur.name });
    return true;
  } catch (err) {
    toast("Couldn't save", { body: String(err), error: true });
    return false;
  }
}

function leaveEditor() {
  const ed = editor;
  if (!ed) return;
  if (!ed.dirty) {
    showGallery();
    return;
  }
  const { close } = modal(
    "Save your changes?",
    h(
      "div",
      { class: "form" },
      h("div", { class: "dim" }, `${cur.name} has changes that aren't saved.`),
      h(
        "div",
        { class: "modal-foot" },
        h(
          "button",
          { class: "btn btn-ghost", onclick: () => close() },
          "Keep editing"
        ),
        h(
          "button",
          {
            class: "btn btn-secondary",
            onclick: () => (close(), showGallery()),
          },
          "Discard"
        ),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => (await save()) && (close(), showGallery()),
          },
          "Save"
        )
      )
    )
  );
}

async function sendCurrent() {
  if (!editor) return;
  if (!(await save()) || !cur.id) return;
  sendDialog([pathOf(cur.id)]);
}

/** Pick a video (the open one, one from the pool or recents, or a file) and put the images on it. */
function sendDialog(paths: string[]) {
  const videos = host.videos();
  let chosen: string | null = videos[0]?.path ?? null;
  let q = "";
  let seconds = store.settings.images.seconds;
  const list = h("div", { class: "pick-list" });
  const body = h("div", { class: "form" });
  const { close } = modal("Send to video", body);

  const drawList = () => {
    const w = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = videos.filter(v =>
      w.every(x => v.name.toLowerCase().includes(x))
    );
    list.replaceChildren(
      ...(rows.length
        ? rows.slice(0, 60).map(v =>
            h(
              "button",
              {
                class: `pick-row${v.path === chosen ? " active" : ""}`,
                title: v.path,
                onclick: () => ((chosen = v.path), drawList(), drawFoot()),
              },
              h("span", { class: "pick-name" }, v.name),
              v.current ? h("span", { class: "chip" }, "Open now") : null
            )
          )
        : [
            h(
              "div",
              { class: "dim small pick-none" },
              videos.length
                ? "No video matches"
                : "No videos yet. Browse for one."
            ),
          ])
    );
  };
  const foot = h("div", { class: "modal-foot" });
  const drawFoot = () =>
    foot.replaceChildren(
      h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel"),
      h(
        "button",
        {
          class: "btn btn-primary",
          disabled: !chosen,
          onclick: async () => {
            const video = chosen;
            if (!video) return;
            store.settings.images.seconds = seconds;
            saveSettings();
            close();
            await host.send(paths, video, seconds);
          },
        },
        `Send ${paths.length} ${paths.length === 1 ? "image" : "images"}`
      )
    );

  body.append(
    h(
      "div",
      { class: "dim small" },
      "Each image goes on its own image track, starting at the playhead. You can move and resize them in the video editor."
    ),
    h("input", {
      class: "input",
      placeholder: "Search videos",
      spellcheck: "false",
      oninput: (e: Event) => (
        (q = (e.target as HTMLInputElement).value),
        drawList()
      ),
    }),
    list,
    h(
      "div",
      { class: "inline" },
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm",
          onclick: async () => {
            const f = await host.browseVideo();
            if (!f) return;
            if (!videos.some(v => v.path === f))
              videos.unshift({ path: f, name: basename(f), current: false });
            chosen = f;
            drawList();
            drawFoot();
          },
        },
        icon(FolderOpen, 14),
        "Browse…"
      ),
      h("div", { class: "spacer" }),
      h("span", { class: "dim small" }, "Shows for"),
      h("input", {
        class: "input input-sm",
        type: "number",
        min: "0.5",
        step: "0.5",
        value: String(seconds),
        onchange: (e: Event) =>
          (seconds = Math.max(
            0.5,
            +(e.target as HTMLInputElement).value || seconds
          )),
      }),
      h("span", { class: "dim small" }, "seconds")
    ),
    foot
  );
  drawList();
  drawFoot();
}

// ---- editor view

let rail: HTMLElement;
let panel: HTMLElement;
let zoomLabel: HTMLElement;

function renderRail() {
  if (!rail || !editor) return;
  rail.replaceChildren(
    ...TOOLS.map(t =>
      h(
        "button",
        {
          class: `ie-tool${editor!.tool === t.tool ? " active" : ""}`,
          "data-tip": t.label,
          "data-key": t.key,
          onclick: () => editor!.setTool(t.tool),
        },
        icon(t.icon, 18)
      )
    ),
    h("div", { class: "ie-rail-sep" }),
    h(
      "button",
      {
        class: "ie-tool",
        "data-tip": "Add a picture",
        onclick: async () => {
          const f = await open({ multiple: true, filters: [IMAGE_FILTER] });
          if (Array.isArray(f))
            for (const p of f)
              await editor?.addPicture(await fileToDataUrl(p), stem(p));
        },
      },
      icon(ImagePlus, 18)
    )
  );
}

function renderEditor() {
  const ed = editor!;
  rail = h("div", { class: "ie-rail" });
  panel = h("aside", { class: "ie-panel" });
  zoomLabel = h("span", { class: "ie-zoom-label" });
  const zoomBar = h(
    "div",
    { class: "ie-zoombar" },
    h(
      "button",
      { class: "icon-btn sm", onclick: () => ed.zoomTo(ed.zoom / 1.25) },
      icon(Minus, 14)
    ),
    zoomLabel,
    h(
      "button",
      { class: "icon-btn sm", onclick: () => ed.zoomTo(ed.zoom * 1.25) },
      icon(Plus, 14)
    ),
    h(
      "button",
      { class: "btn btn-ghost btn-sm", onclick: () => ed.fit() },
      "Fit"
    )
  );
  els
    .main()
    .replaceChildren(
      h(
        "div",
        { class: "ie" },
        rail,
        h("div", { class: "ie-stage" }, ed.el, zoomBar),
        panel
      )
    );
  renderRail();
  renderPanels();
}

function schedulePanels() {
  cancelAnimationFrame(panelFrame);
  panelFrame = requestAnimationFrame(() => {
    renderChrome();
    const f = document.activeElement;
    const typing =
      f instanceof HTMLInputElement && f.type !== "range" && panel?.contains(f);
    if (!typing && !(f instanceof HTMLTextAreaElement && panel?.contains(f)))
      renderPanels();
    else if (editor)
      zoomLabel.textContent = `${Math.round(editor.zoom * 100)}%`;
  });
}

const field = (label: string, ...controls: (Node | null)[]) =>
  h(
    "div",
    { class: "ip-row" },
    h("span", { class: "ip-label" }, label),
    h("div", { class: "ip-ctl" }, ...controls)
  );

function renderPanels() {
  const ed = editor;
  if (!ed || !panel?.isConnected) return;
  zoomLabel.textContent = `${Math.round(ed.zoom * 100)}%`;
  const scroll = panel.scrollTop;
  const sel = ed.selected;
  const ids = sel.map(l => l.id);
  const first = sel[0];

  const num = (
    value: number,
    apply: (v: number) => void,
    opts: { min?: number; max?: number; step?: number } = {}
  ) =>
    h("input", {
      class: "input input-sm",
      type: "number",
      value: String(Math.round(value * 100) / 100),
      min: opts.min != null ? String(opts.min) : null,
      max: opts.max != null ? String(opts.max) : null,
      step: String(opts.step ?? 1),
      onchange: (e: Event) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        if (isFinite(v)) {
          apply(
            opts.min != null
              ? Math.max(opts.min, opts.max != null ? Math.min(opts.max, v) : v)
              : v
          );
          ed.commit();
        }
      },
    });

  const colorCtl = (
    value: string | null,
    fallback: string,
    apply: (v: string | null) => void
  ) => {
    const input = h("input", {
      class: "color-input",
      type: "color",
      value: value ?? fallback,
      disabled: value === null,
      oninput: (e: Event) => apply((e.target as HTMLInputElement).value),
      onchange: () => ed.commit(),
    });
    return h(
      "div",
      { class: "inline" },
      toggle(value !== null, on => (apply(on ? fallback : null), ed.commit())),
      input
    );
  };

  const small = (ic: IconNode, tip: string, run: () => void, on = false) =>
    h(
      "button",
      { class: `icon-btn sm${on ? " on" : ""}`, "data-tip": tip, onclick: run },
      icon(ic, 15)
    );

  const sections: Node[] = [];

  if (sel.length) {
    const one = sel.length === 1 ? first : null;
    const rows: (Node | null)[] = [];
    if (one) {
      rows.push(
        field(
          "Name",
          h("input", {
            class: "input input-sm",
            value: one.name,
            spellcheck: "false",
            onchange: (e: Event) => (
              ed.set(ids, { name: (e.target as HTMLInputElement).value }),
              ed.commit()
            ),
          })
        ),
        field(
          "Position",
          num(one.x, v => ed.set(ids, { x: v })),
          num(one.y, v => ed.set(ids, { y: v }))
        ),
        one.kind === "text"
          ? null
          : field(
              "Size",
              num(one.w, v => ed.set(ids, { w: v }), { min: 1 }),
              num(one.h, v => ed.set(ids, { h: v }), { min: 0 })
            ),
        field(
          "Rotate",
          num(ImageEditor.normRot(one.rot), v => ed.set(ids, { rot: v }), {
            step: 1,
          })
        )
      );
    }
    const kinds = new Set(sel.map(l => l.kind));
    const lineOnly = [...kinds].every(
      k => k === "line" || k === "arrow" || k === "path"
    );
    if (!lineOnly)
      rows.push(
        field(
          "Fill",
          colorCtl(first.fill, store.settings.images.fill, v =>
            ed.set(ids, { fill: v })
          )
        )
      );
    rows.push(
      field(
        lineOnly ? "Color" : "Outline",
        colorCtl(first.stroke, store.settings.images.stroke, v =>
          ed.set(ids, { stroke: v })
        ),
        num(first.sw, v => ed.set(ids, { sw: v }), { min: 0, max: 200 })
      )
    );
    if (kinds.has("rect"))
      rows.push(
        field(
          "Corners",
          num(first.radius, v => ed.set(ids, { radius: v }), { min: 0 })
        )
      );
    rows.push(
      field(
        "Opacity",
        h("input", {
          class: "range",
          type: "range",
          min: "0",
          max: "100",
          value: String(Math.round(first.opacity * 100)),
          oninput: (e: Event) =>
            ed.set(ids, {
              opacity: +(e.target as HTMLInputElement).value / 100,
            }),
          onchange: () => ed.commit(),
        })
      )
    );
    if (one?.kind === "text")
      rows.push(
        field(
          "Text",
          h("textarea", {
            class: "input ie-textarea",
            rows: "2",
            spellcheck: "false",
            value: one.text,
            oninput: (e: Event) =>
              ed.set(ids, {
                text: (e.target as HTMLTextAreaElement).value || " ",
              }),
            onchange: () => ed.commit(),
          })
        ),
        field(
          "Font",
          (() => {
            const s = h("select", {
              class: "input input-sm",
              onchange: (e: Event) => (
                ed.set(ids, { font: (e.target as HTMLSelectElement).value }),
                ed.commit()
              ),
            });
            for (const f of FONTS)
              s.append(h("option", { value: f, selected: f === one.font }, f));
            return s;
          })(),
          num(one.size, v => ed.set(ids, { size: v }), { min: 6, max: 1000 })
        ),
        field(
          "Style",
          small(
            Type,
            "Bold",
            () => (ed.set(ids, { bold: !one.bold }), ed.commit()),
            one.bold
          ),
          segmented(
            [
              { label: "Left", value: "left" as const },
              { label: "Center", value: "center" as const },
              { label: "Right", value: "right" as const },
            ],
            one.align,
            v => (ed.set(ids, { align: v }), ed.commit())
          )
        )
      );
    sections.push(
      h(
        "div",
        { class: "ip-section" },
        h(
          "div",
          { class: "ip-title" },
          one ? one.name : `${sel.length} layers`
        ),
        ...(rows.filter(Boolean) as Node[])
      )
    );

    sections.push(
      h(
        "div",
        { class: "ip-section" },
        h("div", { class: "ip-title" }, "Arrange"),
        h(
          "div",
          { class: "ip-icons" },
          small(ChevronsUp, "To front", () => ed.restack(ids, Infinity)),
          small(ArrowUp, "Forward", () => ed.restack(ids, 1)),
          small(ArrowDown, "Backward", () => ed.restack(ids, -1)),
          small(ChevronsDown, "To back", () => ed.restack(ids, -Infinity)),
          h("span", { class: "ip-gap" }),
          small(AlignHorizontalJustifyStart, "Align left", () =>
            ed.align("left")
          ),
          small(AlignHorizontalJustifyCenter, "Center horizontally", () =>
            ed.align("hcenter")
          ),
          small(AlignHorizontalJustifyEnd, "Align right", () =>
            ed.align("right")
          ),
          small(AlignVerticalJustifyStart, "Align top", () => ed.align("top")),
          small(AlignVerticalJustifyCenter, "Center vertically", () =>
            ed.align("vcenter")
          ),
          small(AlignVerticalJustifyEnd, "Align bottom", () =>
            ed.align("bottom")
          )
        ),
        h(
          "div",
          { class: "ip-icons" },
          small(Copy, "Duplicate (Ctrl D)", () => ed.duplicate()),
          small(
            first.locked ? Lock : LockOpen,
            first.locked ? "Unlock" : "Lock",
            () => (ed.set(ids, { locked: !first.locked }), ed.commit()),
            first.locked
          ),
          small(
            first.hidden ? EyeOff : Eye,
            first.hidden ? "Show" : "Hide",
            () => (ed.set(ids, { hidden: !first.hidden }), ed.commit())
          ),
          small(Trash2, "Delete (Del)", () => ed.remove())
        )
      )
    );
  } else {
    sections.push(canvasSection(ed));
  }

  sections.push(
    h(
      "div",
      { class: "ip-section" },
      h("div", { class: "ip-title" }, "Layers"),
      ed.doc.layers.length
        ? h(
            "div",
            { class: "ip-layers" },
            ...[...ed.doc.layers].reverse().map(l =>
              h(
                "div",
                {
                  class: `ip-layer${ed.sel.includes(l.id) ? " active" : ""}${l.hidden ? " off" : ""}`,
                  onclick: (e: MouseEvent) =>
                    ed.select(
                      e.shiftKey
                        ? ed.sel.includes(l.id)
                          ? ed.sel.filter(x => x !== l.id)
                          : [...ed.sel, l.id]
                        : [l.id]
                    ),
                },
                h("span", { class: "ip-layer-icon" }, icon(kindIcon(l), 14)),
                h(
                  "span",
                  { class: "ip-layer-name" },
                  l.kind === "text"
                    ? l.text.split("\n")[0].slice(0, 28) || l.name
                    : l.name
                ),
                h(
                  "button",
                  {
                    class: "icon-btn sm",
                    "data-tip": l.hidden ? "Show" : "Hide",
                    onclick: (e: MouseEvent) => (
                      e.stopPropagation(),
                      ed.set([l.id], { hidden: !l.hidden }),
                      ed.commit()
                    ),
                  },
                  icon(l.hidden ? EyeOff : Eye, 14)
                ),
                h(
                  "button",
                  {
                    class: "icon-btn sm",
                    "data-tip": l.locked ? "Unlock" : "Lock",
                    onclick: (e: MouseEvent) => (
                      e.stopPropagation(),
                      ed.set([l.id], { locked: !l.locked }),
                      ed.commit()
                    ),
                  },
                  icon(l.locked ? Lock : LockOpen, 14)
                )
              )
            )
          )
        : h(
            "div",
            { class: "dim small" },
            "Nothing here yet. Pick a tool on the left and draw, or paste a picture."
          )
    )
  );

  panel.replaceChildren(...sections);
  panel.scrollTop = scroll;
}

function kindIcon(l: Layer): IconNode {
  return (
    {
      rect: Square,
      ellipse: Circle,
      triangle: Triangle,
      line: Minus,
      arrow: MoveUpRight,
      path: Pencil,
      text: Type,
      image: ImageIcon,
    } as Record<string, IconNode>
  )[l.kind];
}

function canvasSection(ed: ImageEditor) {
  const d = ed.doc;
  const bg = d.bg;
  const swatch = (b: (typeof BACKGROUNDS)[number]) => {
    const same = JSON.stringify(b.bg) === JSON.stringify(bg);
    const style =
      b.bg === null
        ? ""
        : typeof b.bg === "string"
          ? `background:${b.bg}`
          : `background:linear-gradient(135deg, ${b.bg.from}, ${b.bg.to})`;
    return h("button", {
      class: `swatch${same ? " active" : ""}${b.bg === null ? " clear" : ""}`,
      style,
      title: b.label,
      onclick: () => (ed.setDoc({ bg: b.bg }), ed.commit()),
    });
  };
  const dim = (key: "w" | "h") =>
    h("input", {
      class: "input input-sm",
      type: "number",
      min: "16",
      max: "8192",
      value: String(d[key]),
      onchange: (e: Event) => {
        const v = Math.min(
          8192,
          Math.max(
            16,
            Math.round(+(e.target as HTMLInputElement).value || d[key])
          )
        );
        ed.setDoc({ [key]: v });
        ed.commit();
        ed.fit();
      },
    });
  return h(
    "div",
    { class: "ip-section" },
    h("div", { class: "ip-title" }, "Image"),
    field(
      "Name",
      h("input", {
        class: "input input-sm",
        value: cur.name,
        spellcheck: "false",
        onchange: (e: Event) => {
          cur.name = (e.target as HTMLInputElement).value.trim() || "Untitled";
          renderChrome();
        },
      })
    ),
    field(
      "Category",
      h("input", {
        class: "input input-sm",
        list: "img-cat-list-ed",
        value: cur.category,
        placeholder: "Uncategorized",
        spellcheck: "false",
        onchange: (e: Event) =>
          (cur.category = (e.target as HTMLInputElement).value.trim()),
      }),
      h(
        "datalist",
        { id: "img-cat-list-ed" },
        ...categories().map(([c]) => h("option", { value: c }))
      )
    ),
    field(
      "Tags",
      h("input", {
        class: "input input-sm",
        value: cur.tags.join(", "),
        placeholder: "comma, separated",
        spellcheck: "false",
        onchange: (e: Event) =>
          (cur.tags = (e.target as HTMLInputElement).value
            .split(",")
            .map(t => t.trim())
            .filter(Boolean)),
      })
    ),
    field("Canvas", dim("w"), h("span", { class: "dim" }, "×"), dim("h")),
    field(
      "Background",
      h(
        "div",
        { class: "swatches" },
        ...BACKGROUNDS.map(swatch),
        h("input", {
          class: "color-input",
          type: "color",
          value: typeof bg === "string" ? bg : "#ffffff",
          oninput: (e: Event) =>
            ed.setDoc({ bg: (e.target as HTMLInputElement).value }),
          onchange: () => ed.commit(),
        })
      )
    ),
    field(
      "Metadata",
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm",
          onclick: () =>
            openMetadata({
              path: null,
              name: cur.name,
              edit: ed,
              kind: "image",
            }),
        },
        Object.keys(ed.meta.tags).length || ed.meta.strip
          ? "Edit… (changed)"
          : "Edit…"
      )
    )
  );
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

function onKey(e: KeyboardEvent) {
  if (!active || modalOpen() || menuOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (typing(e.target)) {
    if (k === "escape" && (e.target as HTMLElement).id === "img-search")
      (e.target as HTMLElement).blur();
    return;
  }
  const ed = editor;
  if (mod && k === "n") return stop(e, newDialog);
  if (mod && k === "o") return stop(e, () => openFileAsNew());
  if (!ed) {
    if (k === "/") return stop(e, () => $("img-search")?.focus());
    if (mod && k === "a")
      return stop(
        e,
        () => (filtered(filter).forEach(i => picked.add(i.id)), renderMain())
      );
    if (k === "escape" && picked.size)
      return stop(e, () => (picked.clear(), renderMain()));
    if ((k === "delete" || k === "backspace") && picked.size)
      return stop(e, () => confirmDelete([...picked]));
    if (k === "enter" && picked.size === 1)
      return stop(e, () => openItem([...picked][0]));
    return;
  }
  if (mod && k === "s") return stop(e, () => void save());
  if (mod && k === "e") return stop(e, () => exportDialog(ed, cur.name));
  if (mod && e.shiftKey && k === "c") return stop(e, () => void copyImage());
  if (ed.key(e)) {
    e.preventDefault();
    renderChrome();
  }
}

const stop = (e: KeyboardEvent, run: () => void) => {
  e.preventDefault();
  run();
};

async function copyImage() {
  if (!editor) return;
  try {
    const blob = await toPng(await renderDoc(editor.doc));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Image copied");
  } catch (err) {
    toast("Couldn't copy the image", { body: String(err), error: true });
  }
}

function onPaste(e: ClipboardEvent) {
  if (!active || modalOpen() || typing(e.target)) return;
  const file = [...(e.clipboardData?.files ?? [])].find(f =>
    f.type.startsWith("image/")
  );
  if (file) {
    e.preventDefault();
    if (editor) editor.addBlob(file, "Pasted image");
    else
      blobToDataUrl(file)
        .then(src => docFromSrc(src, "Pasted image"))
        .then(d => fresh(d, "Pasted image"));
    return;
  }
  if (editor?.pasteLayers()) e.preventDefault();
}
