import { open } from "@tauri-apps/plugin-dialog";
import { Copy, Upload } from "lucide";

import { api } from "../api";
import { store } from "../settings";
import { basename, h, icon, modal, row, segmented, stem, toast } from "../ui";
import {
  blobToDataUrl,
  fileToDataUrl,
  loadPicture,
  newLayer,
  renderDoc,
  SIZES,
  toPng,
  type Doc,
} from "./doc";
import { ImageEditor } from "./editor";
import { IMAGE_FILTER } from "./export";
import { itemById, newItemId, pathOf, saveItem } from "./library";
import { redraw, st } from "./state";
import { BACKGROUNDS, blankDoc, TEMPLATES } from "./templates";

/**
 * Run `next` once the open picture is safe to close: right away when nothing changed,
 * otherwise after asking to save or discard.
 */
export function whenSaved(next: () => void) {
  const ed = st.editor;
  if (!ed?.dirty) {
    next();
    return;
  }
  const { close } = modal(
    "Save your changes?",
    h(
      "div",
      { class: "form" },
      h(
        "div",
        { class: "dim" },
        `${st.cur.name} has changes that aren't saved.`
      ),
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
            onclick: () => {
              ed.markSaved();
              close();
              next();
            },
          },
          "Discard"
        ),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => {
              if (!(await save())) return;
              close();
              next();
            },
          },
          "Save"
        )
      )
    )
  );
}

export function closeEditor() {
  st.editor?.destroy();
  st.editor = null;
}

function startEditor(doc: Doc, cur: typeof st.cur) {
  whenSaved(() => {
    closeEditor();
    st.cur = cur;
    st.editor = new ImageEditor(doc);
    redraw.go("editor");
  });
}

const fresh = (doc: Doc, name = "Untitled") =>
  startEditor(doc, {
    id: null,
    name,
    category: st.filter.category ?? "",
    tags: [],
  });

export async function openItem(id: string) {
  const item = itemById(id);
  if (!item) return;
  if (st.cur.id === id && st.editor) {
    redraw.go("editor");
    return;
  }
  let doc = (await api.imageDocRead(id).catch(() => null)) as Doc | null;
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
  startEditor(doc, {
    id,
    name: item.name,
    category: item.category,
    tags: [...item.tags],
  });
}

/** A picture as a new document the size of the picture, with its own tags carried along. */
export async function docFromSrc(src: string, name: string, path?: string) {
  const img = await loadPicture(src);
  const w = img.naturalWidth;
  const hgt = img.naturalHeight;
  const doc: Doc = {
    w,
    h: hgt,
    bg: null,
    layers: [newLayer("image", { name, src, x: w / 2, y: hgt / 2, w, h: hgt })],
  };
  if (path) {
    const tags = await api.imageTagsRead(path).catch(() => ({}));
    if (Object.keys(tags).length) doc.meta = { tags, strip: false };
  }
  return doc;
}

export async function openFileAsNew(path?: string) {
  const picked =
    path ?? (await open({ multiple: false, filters: [IMAGE_FILTER] }));
  if (typeof picked !== "string") return;
  try {
    fresh(
      await docFromSrc(await fileToDataUrl(picked), stem(picked), picked),
      stem(picked)
    );
  } catch {
    toast("Couldn't read that image", { body: basename(picked), error: true });
  }
}

export async function openBlob(blob: Blob, name = "Pasted image") {
  fresh(await docFromSrc(await blobToDataUrl(blob), name), name);
}

async function clipboardBlob() {
  try {
    for (const item of await navigator.clipboard.read())
      for (const type of item.types)
        if (type.startsWith("image/")) return await item.getType(type);
  } catch {}
  return null;
}

/** Copy picture files into the library (as PNG, tags kept) without opening the editor. */
export async function importFiles(paths: string[]) {
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
          category: st.filter.category ?? "",
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

export async function importDialog() {
  const files = await open({ multiple: true, filters: [IMAGE_FILTER] });
  if (Array.isArray(files) && files.length) importFiles(files);
}

export async function save() {
  const ed = st.editor;
  if (!ed) return false;
  ed.commitText();
  try {
    const png = new Uint8Array(
      await (await toPng(await renderDoc(ed.doc))).arrayBuffer()
    );
    const c = st.cur;
    const id = c.id ?? newItemId();
    await saveItem(
      {
        id,
        name: c.name,
        category: c.category,
        tags: c.tags,
        w: ed.doc.w,
        h: ed.doc.h,
      },
      png,
      ed.doc
    );
    c.id = id;
    ed.markSaved();
    redraw.chrome();
    toast("Saved to the library", { body: c.name });
    return true;
  } catch (err) {
    toast("Couldn't save", { body: String(err), error: true });
    return false;
  }
}

export function newDialog() {
  const p = store.settings.images;
  let size = p.size in SIZES ? p.size : "video";
  let bg = BACKGROUNDS.find(b => b.bg === p.bg) ?? BACKGROUNDS[0];
  let template = "blank";
  let w = SIZES[size].w;
  let hgt = SIZES[size].h;
  const body = h("div", { class: "form new-image" });
  const { close } = modal("New image", body, { wide: true });

  const swatch = (b: (typeof BACKGROUNDS)[number]) =>
    h("button", {
      class: `swatch${b === bg ? " active" : ""}${b.bg === null ? " clear" : ""}`,
      style: swatchStyle(b.bg),
      title: b.label,
      onclick: () => ((bg = b), render()),
    });

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
                    w = SIZES[v].w;
                    hgt = SIZES[v].h;
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
                    value: String(w),
                    onchange: (e: Event) =>
                      (w = +(e.target as HTMLInputElement).value || w),
                  }),
                  h("span", { class: "dim" }, "×"),
                  h("input", {
                    class: "input input-sm",
                    type: "number",
                    min: "16",
                    max: "8192",
                    value: String(hgt),
                    onchange: (e: Event) =>
                      (hgt = +(e.target as HTMLInputElement).value || hgt),
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
                openBlob(blob);
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
                  d.w = Math.min(8192, Math.max(16, Math.round(w)));
                  d.h = Math.min(8192, Math.max(16, Math.round(hgt)));
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

export const swatchStyle = (bg: Doc["bg"]) =>
  bg === null
    ? ""
    : typeof bg === "string"
      ? `background:${bg}`
      : `background:linear-gradient(135deg, ${bg.from}, ${bg.to})`;
