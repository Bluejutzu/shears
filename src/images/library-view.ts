import {
  Check,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Upload,
} from "lucide";

import { api } from "../shared/api";
import { saveSettings, store } from "../shared/settings";
import { h, icon, menu, row, segmented, type MenuItem } from "../shared/ui";
import { ask, marked, searchBox } from "./bits";
import { convertAdd } from "./convert";
import { importDialog, newDialog, openItem } from "./create";
import { flowPreselect } from "./flow";
import {
  allItems,
  categories,
  filtered,
  itemById,
  pathOf,
  removeItems,
  thumbUrl,
  updateItems,
  type ImageItem,
} from "./library";
import { redraw, st } from "./state";

const items = (ids: string[]) => ids.flatMap(id => itemById(id) ?? []);

export function sendIds(ids: string[]) {
  flowPreselect(ids);
  redraw.go("send");
}

export function convertIds(ids: string[]) {
  convertAdd(
    items(ids).map(i => ({ path: pathOf(i.id), name: `${i.name}.png` }))
  );
  redraw.go("convert");
}

let grid: HTMLElement | null = null;
let head: HTMLElement | null = null;

export function renderLibrary(root: HTMLElement) {
  const f = st.filter;
  const title =
    f.category === null
      ? "All images"
      : f.category === ""
        ? "Uncategorized"
        : f.category;
  head = h("h1", {});
  grid = h("div", { class: "img-grid-wrap" });
  root.replaceChildren(
    h(
      "div",
      { class: "img-gallery" },
      h(
        "div",
        { class: "page-head row" },
        head,
        h("div", { class: "spacer" }),
        searchBox(
          f.q,
          "Search names, categories, tags",
          v => {
            f.q = v;
            drawGrid();
          },
          "img-search"
        ),
        h(
          "button",
          { class: "btn btn-secondary btn-sm", onclick: importDialog },
          icon(Upload, 14),
          "Import"
        ),
        segmented(
          [
            { label: "Newest", value: "new" as const },
            { label: "Name", value: "name" as const },
            { label: "Largest", value: "size" as const },
          ],
          f.sort,
          v => {
            f.sort = store.settings.images.sort = v;
            saveSettings();
            redraw.main();
          }
        )
      ),
      grid
    )
  );
  head.dataset.title = title;
  drawGrid();
}

/** Just the cards and the selection bar, so typing in search keeps focus. */
export function drawGrid() {
  if (!grid?.isConnected || !head) return;
  const list = filtered(st.filter);
  const any = allItems().length > 0;
  head.replaceChildren(
    head.dataset.title ?? "",
    h("span", { class: "media-count" }, String(list.length))
  );
  grid.replaceChildren(
    list.length
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
        ),
    ...(st.picked.size ? [selectionBar()] : [])
  );
}

function card(i: ImageItem) {
  const on = st.picked.has(i.id);
  const toggleOne = (shift: boolean) => {
    const p = st.picked;
    if (shift && st.lastPicked) {
      const ids = filtered(st.filter).map(x => x.id);
      const [a, b] = [ids.indexOf(st.lastPicked), ids.indexOf(i.id)].sort(
        (x, y) => x - y
      );
      for (const id of ids.slice(a, b + 1)) p.add(id);
    } else if (p.has(i.id)) p.delete(i.id);
    else p.add(i.id);
    st.lastPicked = i.id;
    drawGrid();
  };
  return h(
    "div",
    {
      class: `img-card${on ? " picked" : ""}`,
      role: "button",
      title: `${i.name} · ${i.w}×${i.h}`,
      onclick: (e: MouseEvent) => {
        if (st.picked.size || e.ctrlKey || e.shiftKey || e.metaKey)
          toggleOne(e.shiftKey);
        else openItem(i.id);
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        if (!st.picked.has(i.id)) {
          st.picked.clear();
          st.picked.add(i.id);
          st.lastPicked = i.id;
          drawGrid();
        }
        menu({ x: e.clientX, y: e.clientY }, itemMenu([...st.picked]));
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
        on ? icon(Check, 13, 2.5) : null
      )
    ),
    h(
      "div",
      { class: "img-meta" },
      h("div", { class: "img-name" }, ...marked(i.name, st.filter.q)),
      h(
        "div",
        { class: "img-sub" },
        h("span", {}, `${i.w} × ${i.h}`),
        i.category
          ? h(
              "span",
              { class: "img-cat-tag" },
              ...marked(i.category, st.filter.q)
            )
          : null,
        ...i.tags
          .slice(0, 3)
          .map(t => h("span", { class: "img-tag" }, ...marked(t, st.filter.q)))
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
      label: n > 1 ? `Send ${n} to a video…` : "Send to a video…",
      icon: Send,
      run: () => sendIds(ids),
    },
    { label: "Convert…", icon: RefreshCw, run: () => convertIds(ids) },
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
  const ids = [...st.picked];
  return h(
    "div",
    { class: "img-selbar" },
    h("span", { class: "img-selcount" }, `${ids.length} selected`),
    h(
      "button",
      { class: "btn btn-primary btn-sm", onclick: () => sendIds(ids) },
      icon(Send, 14),
      "Send to a video"
    ),
    h(
      "button",
      { class: "btn btn-secondary btn-sm", onclick: () => convertIds(ids) },
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
          st.picked.clear();
          drawGrid();
        },
      },
      "Clear"
    )
  );
}

export function confirmDelete(ids: string[]) {
  ask(
    ids.length > 1 ? `Delete ${ids.length} images?` : "Delete this image?",
    h(
      "div",
      { class: "dim" },
      "This removes them from the library for good. A video that already uses one of them will lose that image."
    ),
    "Delete",
    () => {
      st.picked.clear();
      removeItems(ids);
    },
    true
  );
}

/** One dialog for a single image (name, category, tags) or many (category, extra tags). */
function detailsDialog(ids: string[]) {
  const list = items(ids);
  if (!list.length) return;
  const one = list.length === 1 ? list[0] : null;
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
  ask(
    one ? "Image details" : `${list.length} images`,
    h(
      "div",
      { class: "form" },
      ...(one ? [row("Name", name)] : []),
      row(
        "Category",
        h(
          "div",
          {},
          category,
          h(
            "datalist",
            { id: "img-cat-list" },
            ...categories().map(([c]) => h("option", { value: c }))
          )
        )
      ),
      row("Tags", tags)
    ),
    "Save",
    () => {
      const typed = tags.value
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      if (one)
        updateItems([one.id], {
          name: name.value.trim() || one.name,
          category: category.value.trim(),
          tags: typed,
        });
      else
        for (const i of list)
          updateItems([i.id], {
            ...(category.value.trim()
              ? { category: category.value.trim() }
              : {}),
            tags: [...new Set([...i.tags, ...typed])],
          });
    }
  );
}

export function renameCategory(name: string) {
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
    if (st.filter.category === name) st.filter.category = next;
  });
}

export function removeCategory(name: string) {
  updateItems(
    allItems()
      .filter(i => i.category === name)
      .map(i => i.id),
    { category: "" }
  );
  if (st.filter.category === name) st.filter.category = null;
}
