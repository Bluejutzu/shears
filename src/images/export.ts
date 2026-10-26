import { save } from "@tauri-apps/plugin-dialog";

import { api, fileUrl } from "../api";
import { openMetadata } from "../metadata";
import { store, saveSettings } from "../settings";
import {
  basename,
  dirname,
  ext,
  h,
  join,
  modal,
  row,
  segmented,
  stem,
  toast,
} from "../ui";
import { loadPicture, renderDoc, type Doc } from "./doc";
import type { ImageEditor } from "./editor";

export type Format = "png" | "jpeg" | "webp";

export const FORMATS: {
  label: string;
  value: Format;
  ext: string;
  mime: string;
}[] = [
  { label: "PNG", value: "png", ext: "png", mime: "image/png" },
  { label: "JPEG", value: "jpeg", ext: "jpg", mime: "image/jpeg" },
  { label: "WebP", value: "webp", ext: "webp", mime: "image/webp" },
];

export const IMAGE_FILTER = {
  name: "Images",
  extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
};

const fmtOf = (f: Format) => FORMATS.find(x => x.value === f)!;
/** Only these can carry tags (see imgmeta.rs). */
const holdsTags = (f: Format) => f === "png" || f === "jpeg";
const lossy = (f: Format) => f !== "png";

/** The file type a path already is, when it's one we can write. */
export function formatOf(path: string): Format | null {
  const e = ext(path);
  return e === "jpg" || e === "jpeg"
    ? "jpeg"
    : e === "png"
      ? "png"
      : e === "webp"
        ? "webp"
        : null;
}

/** Encode a canvas. Formats without transparency get `flatten` painted behind the picture. */
export async function encode(
  src: HTMLCanvasElement,
  format: Format,
  quality: number,
  scale = 1,
  flatten = "#ffffff"
) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (format === "jpeg") {
    ctx.fillStyle = flatten;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>(r =>
    c.toBlob(r, fmtOf(format).mime, quality / 100)
  );
  if (!blob)
    throw new Error(`Couldn't make a ${fmtOf(format).label} of this picture`);
  return new Uint8Array(await blob.arrayBuffer());
}

const qualityRow = (value: number, set: (v: number) => void) => {
  const label = h("span", { class: "value-label" }, `${value}%`);
  return row(
    "Quality",
    h(
      "div",
      { class: "gain-row" },
      h("input", {
        class: "range",
        type: "range",
        min: "40",
        max: "100",
        step: "1",
        value: String(value),
        oninput: (e: Event) => {
          const v = +(e.target as HTMLInputElement).value;
          label.textContent = `${v}%`;
          set(v);
        },
      }),
      label
    )
  );
};

/** Export the open picture as PNG, JPEG or WebP, with the tags edited in the Metadata dialog. */
export function exportDialog(editor: ImageEditor, name: string) {
  const p = store.settings.images;
  let format = (
    ["png", "jpeg", "webp"].includes(p.format) ? p.format : "png"
  ) as Format;
  let quality = p.quality;
  let scale = 1;
  let flatten = "#ffffff";
  let busy = false;
  const body = h("div", { class: "form" });
  const { close } = modal("Export image", body);

  const render = () => {
    const d = editor.doc;
    const tagCount = Object.keys(editor.meta.tags).length;
    body.replaceChildren(
      row(
        "Format",
        segmented(
          FORMATS.map(f => ({ label: f.label, value: f.value })),
          format,
          v => {
            format = v;
            p.format = v;
            saveSettings();
            render();
          }
        ),
        format === "png"
          ? "Lossless, keeps transparency."
          : format === "jpeg"
            ? "Small files, no transparency."
            : "Small files, keeps transparency."
      ),
      ...(lossy(format)
        ? [
            qualityRow(
              quality,
              v => ((quality = p.quality = v), saveSettings())
            ),
          ]
        : []),
      row(
        "Size",
        segmented(
          [
            { label: "½×", value: 0.5 },
            { label: "1×", value: 1 },
            { label: "2×", value: 2 },
          ],
          scale,
          v => {
            scale = v;
            render();
          }
        ),
        `${Math.round(d.w * scale)} × ${Math.round(d.h * scale)} px`
      ),
      ...(format === "jpeg"
        ? [
            row(
              "Background",
              h("input", {
                class: "color-input",
                type: "color",
                value: flatten,
                oninput: (e: Event) =>
                  (flatten = (e.target as HTMLInputElement).value),
              }),
              "Shown wherever the picture is see-through."
            ),
          ]
        : []),
      row(
        "Metadata",
        h(
          "div",
          { class: "inline" },
          h(
            "span",
            { class: "dim small" },
            !holdsTags(format)
              ? `${fmtOf(format).label} files can't hold metadata`
              : editor.meta.strip
                ? "Left out"
                : tagCount
                  ? `${tagCount} ${tagCount === 1 ? "tag" : "tags"} will be written`
                  : "None yet"
          ),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: () =>
                openMetadata({
                  path: null,
                  name,
                  edit: editor,
                  kind: "image",
                  onClose: render,
                }),
            },
            "Edit…"
          )
        )
      ),
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
            class: "btn btn-primary",
            disabled: busy,
            onclick: async () => {
              const f = fmtOf(format);
              const dir = store.settings.exportDir;
              const target = await save({
                defaultPath: dir
                  ? join(dir, `${name}.${f.ext}`)
                  : `${name}.${f.ext}`,
                filters: [{ name: f.label, extensions: [f.ext] }],
              });
              if (!target) return;
              busy = true;
              render();
              try {
                const canvas = await renderDoc(editor.doc);
                await api.fileWrite(
                  target,
                  await encode(canvas, format, quality, scale, flatten)
                );
                if (holdsTags(format) && (tagCount || editor.meta.strip))
                  await api.imageTagsWrite(target, editor.metaEdit());
                close();
                toast("Image exported", {
                  body: basename(target),
                  action: { label: "Show", run: () => api.reveal(target) },
                });
              } catch (err) {
                busy = false;
                render();
                toast("Couldn't export", { body: String(err), error: true });
              }
            },
          },
          busy ? "Exporting…" : "Export"
        )
      )
    );
  };
  render();
}

export type ConvertOpts = {
  format: Format;
  quality: number;
  /** behind see-through parts, for JPEG */
  flatten: string;
  /** copy the original's tags into the new file */
  keep: boolean;
  /** null = next to the original */
  folder: string | null;
};

export const holdsMeta = holdsTags;
export const isLossy = lossy;

/** Turn one picture file into another type and return where the new file went. */
export async function convertFile(path: string, o: ConvertOpts) {
  const img = await loadPicture(fileUrl(path));
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  const bytes = await encode(c, o.format, o.quality, 1, o.flatten);
  const out = await api.uniquePath(
    join(o.folder ?? dirname(path), `${stem(path)}.${fmtOf(o.format).ext}`)
  );
  await api.fileWrite(out, bytes);
  if (o.keep && holdsTags(o.format)) {
    const tags = await api.imageTagsRead(path).catch(() => ({}));
    if (Object.keys(tags).length)
      await api.imageTagsWrite(out, {
        strip: false,
        tags: Object.entries(tags),
      });
  }
  return { out, size: bytes.length };
}

export type { Doc };
