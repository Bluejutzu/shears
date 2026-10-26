import { open, save } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide";

import { api, fileUrl } from "../api";
import { openMetadata } from "../metadata";
import { store, saveSettings } from "../settings";
import {
  basename,
  dirname,
  ext,
  h,
  icon,
  join,
  modal,
  row,
  segmented,
  stem,
  toast,
  toggle,
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

/** Turn existing picture files into another type, keeping their metadata when asked. */
export function convertDialog(files: { path: string; name: string }[]) {
  const p = store.settings.images;
  let format = (
    ["png", "jpeg", "webp"].includes(p.format) ? p.format : "png"
  ) as Format;
  let quality = p.quality;
  let keep = true;
  let flatten = "#ffffff";
  let folder: string | null = null;
  let busy = false;
  let done = 0;
  const body = h("div", { class: "form" });
  const { close } = modal("Convert images", body);

  const render = () => {
    const f = fmtOf(format);
    const same = files.filter(x => formatOf(x.path) === format).length;
    body.replaceChildren(
      row(
        "Files",
        h(
          "div",
          { class: "dim small" },
          files.length === 1 ? files[0].name : `${files.length} images`
        )
      ),
      row(
        "Convert to",
        segmented(
          FORMATS.map(x => ({ label: x.label, value: x.value })),
          format,
          v => {
            format = v;
            render();
          }
        ),
        same
          ? `${same} of them ${same === 1 ? "is" : "are"} already ${f.label}; they'll be saved again as a copy.`
          : undefined
      ),
      ...(lossy(format) ? [qualityRow(quality, v => (quality = v))] : []),
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
              "Shown wherever a picture is see-through."
            ),
          ]
        : []),
      row(
        "Metadata",
        h(
          "div",
          { class: "inline" },
          toggle(keep, on => ((keep = on), render())),
          h(
            "span",
            { class: "dim small" },
            !holdsTags(format)
              ? `${f.label} files can't hold metadata`
              : keep
                ? "Copy tags over from the originals"
                : "Leave them out"
          )
        )
      ),
      row(
        "Save to",
        h(
          "div",
          { class: "file-pick" },
          h(
            "div",
            { class: "file-pick-path" },
            h(
              "span",
              { class: folder ? "" : "dim" },
              folder ?? "Next to each original"
            )
          ),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm",
              onclick: async () => {
                const d = await open({ directory: true });
                if (typeof d === "string") {
                  folder = d;
                  render();
                }
              },
            },
            icon(FolderOpen, 14),
            "Choose"
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
              busy = true;
              p.format = format;
              p.quality = quality;
              saveSettings();
              let failed = 0;
              let last = "";
              for (const file of files) {
                try {
                  const img = await loadPicture(fileUrl(file.path));
                  const c = document.createElement("canvas");
                  c.width = img.naturalWidth;
                  c.height = img.naturalHeight;
                  c.getContext("2d")!.drawImage(img, 0, 0);
                  const bytes = await encode(c, format, quality, 1, flatten);
                  const out = await api.uniquePath(
                    join(
                      folder ?? dirname(file.path),
                      `${stem(file.path)}.${f.ext}`
                    )
                  );
                  await api.fileWrite(out, bytes);
                  if (keep && holdsTags(format)) {
                    const tags = await api
                      .imageTagsRead(file.path)
                      .catch(() => ({}));
                    if (Object.keys(tags).length)
                      await api.imageTagsWrite(out, {
                        strip: false,
                        tags: Object.entries(tags),
                      });
                  }
                  last = out;
                } catch {
                  failed++;
                }
                done++;
                render();
              }
              close();
              toast(
                failed
                  ? `Converted ${files.length - failed} of ${files.length}`
                  : files.length === 1
                    ? "Image converted"
                    : `${files.length} images converted`,
                {
                  body: failed ? "Some files couldn't be read" : undefined,
                  error: failed === files.length,
                  action: last
                    ? { label: "Show", run: () => api.reveal(last) }
                    : undefined,
                }
              );
            },
          },
          busy ? `Converting ${done} of ${files.length}…` : "Convert"
        )
      )
    );
  };
  render();
}

export type { Doc };
