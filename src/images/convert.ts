import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  FolderOpen,
  Image as ImageIcon,
  RefreshCw,
  TriangleAlert,
  Upload,
  X,
} from "lucide";

import { api, fileUrl } from "../shared/api";
import { colourInput } from "../shared/colour-picker";
import { saveSettings, store } from "../shared/settings";
import {
  basename,
  ext,
  fmtSize,
  h,
  icon,
  segmented,
  toast,
  toggle,
} from "../shared/ui";
import {
  convertFile,
  FORMATS,
  holdsMeta,
  IMAGE_FILTER,
  isLossy,
  type ConvertOpts,
  type Format,
} from "./export";
import { pickFromLibrary } from "./flow";

type Row = {
  path: string;
  name: string;
  status: "waiting" | "working" | "done" | "failed";
  out?: string;
  size?: number;
};

// the list survives switching pages, so files can be gathered from a few places
const rows: Row[] = [];
let root: HTMLElement | null = null;
let busy = false;
let keep = true;
let flatten = "#ffffff";
let folder: string | null = null;

export function convertAdd(files: { path: string; name: string }[]) {
  for (const f of files)
    if (!rows.some(r => r.path === f.path))
      rows.push({ ...f, status: "waiting" });
  draw();
}

const typeLabel = (path: string) => {
  const e = ext(path);
  return e === "jpg" ? "JPEG" : e.toUpperCase();
};

export function renderConvert(el: HTMLElement) {
  root = el;
  draw();
}

function draw() {
  if (!root?.isConnected) return;
  const p = store.settings.images;
  const format = (
    FORMATS.some(f => f.value === p.format) ? p.format : "png"
  ) as Format;
  const target = FORMATS.find(f => f.value === format)!;
  const waiting = rows.filter(r => r.status !== "done").length;
  const done = rows.filter(r => r.status === "done");

  const addFiles = async () => {
    const files = await open({ multiple: true, filters: [IMAGE_FILTER] });
    if (Array.isArray(files))
      convertAdd(files.map(path => ({ path, name: basename(path) })));
  };
  const addLibrary = async () => convertAdd((await pickFromLibrary()) ?? []);

  const list = rows.length
    ? h(
        "div",
        { class: "cv-list" },
        ...rows.map(r =>
          h(
            "div",
            { class: `cv-row ${r.status}` },
            h(
              "div",
              { class: "cv-thumb" },
              h("img", {
                src: fileUrl(r.path),
                alt: "",
                draggable: "false",
                loading: "lazy",
              })
            ),
            h(
              "div",
              { class: "cv-text" },
              h("div", { class: "cv-name", title: r.path }, r.name),
              h(
                "div",
                { class: "cv-sub" },
                r.status === "done" && r.out
                  ? `${typeLabel(r.path)} → ${typeLabel(r.out)} · ${fmtSize(r.size ?? 0)}`
                  : `${typeLabel(r.path)} → ${target.label}`
              )
            ),
            r.status === "done"
              ? h(
                  "button",
                  {
                    class: "btn btn-ghost btn-sm",
                    onclick: () => api.reveal(r.out!),
                  },
                  icon(Check, 14),
                  "Show"
                )
              : r.status === "failed"
                ? h(
                    "span",
                    { class: "cv-status bad" },
                    icon(TriangleAlert, 14),
                    "Couldn't read"
                  )
                : r.status === "working"
                  ? h(
                      "span",
                      { class: "cv-status" },
                      h("span", { class: "spinner sm" }),
                      "Converting"
                    )
                  : null,
            busy
              ? null
              : h(
                  "button",
                  {
                    class: "icon-btn sm",
                    "data-tip": "Remove from the list",
                    onclick: () => {
                      rows.splice(rows.indexOf(r), 1);
                      draw();
                    },
                  },
                  icon(X, 14)
                )
          )
        )
      )
    : null;

  const option = (title: string, desc: string | null, control: Node) =>
    h(
      "div",
      { class: "cv-opt" },
      h("div", { class: "cv-opt-title" }, title),
      control,
      desc ? h("div", { class: "cv-opt-desc" }, desc) : null
    );

  const quality = h("span", { class: "value-label" }, `${p.quality}%`);

  root.replaceChildren(
    h(
      "div",
      { class: "cv" },
      h(
        "div",
        { class: "cv-main" },
        h(
          "div",
          { class: "page-head" },
          h("h1", {}, "Convert images"),
          h(
            "div",
            { class: "page-sub" },
            "Turn pictures into PNG, JPEG or WebP. The originals stay as they are."
          )
        ),
        h(
          "div",
          {
            class: `cv-drop${rows.length ? " small" : ""}`,
            role: "button",
            onclick: (e: MouseEvent) =>
              !(e.target as HTMLElement).closest("button") && addFiles(),
          },
          h("div", { class: "dz-icon" }, icon(Upload, 20)),
          h(
            "div",
            { class: "cv-drop-title" },
            rows.length ? "Drop more pictures here" : "Drop pictures here"
          ),
          h(
            "div",
            { class: "inline" },
            h(
              "button",
              { class: "btn btn-secondary btn-sm", onclick: addFiles },
              icon(FolderOpen, 14),
              "Add files…"
            ),
            h(
              "button",
              { class: "btn btn-secondary btn-sm", onclick: addLibrary },
              icon(ImageIcon, 14),
              "From the library…"
            )
          )
        ),
        list,
        rows.length && !busy
          ? h(
              "div",
              { class: "cv-foot" },
              h(
                "span",
                { class: "dim small" },
                `${rows.length} ${rows.length === 1 ? "picture" : "pictures"}`
              ),
              h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  onclick: () => {
                    rows.length = 0;
                    draw();
                  },
                },
                "Clear list"
              )
            )
          : null
      ),
      h(
        "aside",
        { class: "cv-side" },
        h("div", { class: "cv-side-title" }, "Output"),
        option(
          "Format",
          format === "png"
            ? "Lossless, keeps transparency."
            : format === "jpeg"
              ? "Smallest files, no transparency."
              : "Small files, keeps transparency.",
          segmented(
            FORMATS.map(f => ({ label: f.label, value: f.value })),
            format,
            v => {
              p.format = v;
              saveSettings();
              draw();
            }
          )
        ),
        isLossy(format)
          ? option(
              "Quality",
              null,
              h(
                "div",
                { class: "gain-row" },
                h("input", {
                  class: "range",
                  type: "range",
                  min: "40",
                  max: "100",
                  value: String(p.quality),
                  oninput: (e: Event) => {
                    p.quality = +(e.target as HTMLInputElement).value;
                    quality.textContent = `${p.quality}%`;
                  },
                  onchange: () => saveSettings(),
                }),
                quality
              )
            )
          : null,
        format === "jpeg"
          ? option(
              "Background",
              "Shown wherever a picture is see-through.",
              colourInput({ value: flatten, onInput: v => (flatten = v) })
            )
          : null,
        option(
          "Metadata",
          holdsMeta(format)
            ? "Title, author, date and the rest come along from the original."
            : `${target.label} files can't hold metadata, so it's left out.`,
          h(
            "div",
            { class: "inline" },
            toggle(keep && holdsMeta(format), on => ((keep = on), draw())),
            h("span", { class: "small" }, "Keep tags")
          )
        ),
        option(
          "Save to",
          null,
          h(
            "div",
            { class: "file-pick" },
            h(
              "div",
              { class: "file-pick-path", title: folder ?? "" },
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
                    draw();
                  }
                },
              },
              "Change"
            ),
            folder
              ? h(
                  "button",
                  {
                    class: "btn btn-ghost btn-sm",
                    onclick: () => ((folder = null), draw()),
                  },
                  "Reset"
                )
              : null
          )
        ),
        h("div", { class: "spacer" }),
        h(
          "button",
          {
            class: "btn btn-primary cv-go",
            disabled: busy || !waiting,
            onclick: () =>
              run({ format, quality: p.quality, flatten, keep, folder }),
          },
          icon(RefreshCw, 15),
          busy
            ? "Converting…"
            : waiting
              ? `Convert ${waiting} ${waiting === 1 ? "picture" : "pictures"}`
              : done.length
                ? "All converted"
                : "Add pictures to convert"
        )
      )
    )
  );
}

async function run(o: ConvertOpts) {
  busy = true;
  let ok = 0;
  let last = "";
  for (const r of rows) {
    if (r.status === "done") continue;
    r.status = "working";
    draw();
    try {
      const res = await convertFile(r.path, o);
      r.status = "done";
      r.out = last = res.out;
      r.size = res.size;
      ok++;
    } catch {
      r.status = "failed";
    }
  }
  busy = false;
  draw();
  const failed = rows.filter(r => r.status === "failed").length;
  toast(ok === 1 ? "Picture converted" : `${ok} pictures converted`, {
    body: failed ? `${failed} couldn't be read` : undefined,
    error: !ok,
    action: last ? { label: "Show", run: () => api.reveal(last) } : undefined,
  });
}
