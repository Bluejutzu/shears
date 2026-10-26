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
  Bold,
  ChevronsDown,
  ChevronsUp,
  Circle,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  ImagePlus,
  Lock,
  LockOpen,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Plus,
  Square,
  Trash2,
  Triangle,
  Type,
  type IconNode,
} from "lucide";

import { openMetadata } from "../shared/metadata";
import { store } from "../shared/settings";
import { h, icon, segmented, stem, toggle } from "../shared/ui";
import { tipBtn } from "./bits";
import { swatchStyle } from "./create";
import { fileToDataUrl, FONTS, type Layer } from "./doc";
import { ImageEditor, type Tool } from "./editor";
import { IMAGE_FILTER } from "./export";
import { categories } from "./library";
import { redraw, st } from "./state";
import { BACKGROUNDS } from "./templates";

export const TOOLS: {
  tool: Tool;
  label: string;
  key: string;
  icon: IconNode;
}[] = [
  { tool: "select", label: "Select", key: "V", icon: MousePointer2 },
  { tool: "rect", label: "Rectangle", key: "R", icon: Square },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { tool: "triangle", label: "Triangle", key: "Y", icon: Triangle },
  { tool: "line", label: "Line", key: "L", icon: Minus },
  { tool: "arrow", label: "Arrow", key: "A", icon: MoveUpRight },
  { tool: "pen", label: "Pen", key: "P", icon: Pencil },
  { tool: "text", label: "Text", key: "T", icon: Type },
];

const KIND_ICON: Record<Layer["kind"], IconNode> = {
  rect: Square,
  ellipse: Circle,
  triangle: Triangle,
  line: Minus,
  arrow: MoveUpRight,
  path: Pencil,
  text: Type,
  image: ImageIcon,
};

let rail: HTMLElement;
let layers: HTMLElement;
let toolbar: HTMLElement;
let props: HTMLElement;
let zoombar: HTMLElement;
let frame = 0;

export function renderEditor(root: HTMLElement) {
  const ed = st.editor!;
  rail = h("div", { class: "ie-rail" });
  layers = h("aside", { class: "ie-layers" });
  toolbar = h("div", { class: "ie-toolbar" });
  props = h("aside", { class: "ie-props" });
  zoombar = h("div", { class: "ie-zoombar" });
  root.replaceChildren(
    h(
      "div",
      { class: "ie" },
      rail,
      layers,
      h(
        "div",
        { class: "ie-center" },
        toolbar,
        h("div", { class: "ie-stage" }, ed.el, zoombar)
      ),
      props
    )
  );
  ed.onChange = schedule;
  ed.onTool = drawRail;
  drawRail();
  drawAll();
}

function schedule() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawAll);
}

function drawAll() {
  if (!st.editor || !props?.isConnected) return;
  redraw.chrome();
  drawToolbar();
  drawLayers();
  // don't pull the field out from under someone typing in it
  const f = document.activeElement;
  const typing =
    (f instanceof HTMLInputElement &&
      f.type !== "range" &&
      f.type !== "color") ||
    f instanceof HTMLTextAreaElement ||
    f instanceof HTMLSelectElement;
  if (!(typing && props.contains(f))) drawProps();
}

async function addPictures() {
  const files = await open({ multiple: true, filters: [IMAGE_FILTER] });
  if (Array.isArray(files))
    for (const p of files)
      await st.editor?.addPicture(await fileToDataUrl(p), stem(p));
}

function drawRail() {
  const ed = st.editor;
  if (!ed) return;
  rail.replaceChildren(
    ...TOOLS.map(t =>
      h(
        "button",
        {
          class: `ie-tool${ed.tool === t.tool ? " active" : ""}`,
          "data-tip": t.label,
          "data-key": t.key,
          "aria-label": t.label,
          onclick: () => ed.setTool(t.tool),
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
        "aria-label": "Add a picture",
        onclick: addPictures,
      },
      icon(ImagePlus, 18)
    )
  );
}

// ---- top toolbar: what you can do with the selection, and the zoom

function drawToolbar() {
  const ed = st.editor!;
  const sel = ed.selected;
  const ids = sel.map(l => l.id);
  const first = sel[0];
  const none = !sel.length;
  const group = (...kids: Node[]) =>
    h("div", { class: "ie-tb-group" }, ...kids);
  const btn = (
    ic: IconNode,
    tip: string,
    run: () => void,
    key?: string,
    on = false
  ) => tipBtn(ic, tip, run, { key, off: none, on, below: true });

  toolbar.replaceChildren(
    group(
      btn(
        ChevronsUp,
        "Bring to front",
        () => ed.restack(ids, Infinity),
        "Ctrl ]"
      ),
      btn(ArrowUp, "Bring forward", () => ed.restack(ids, 1), "]"),
      btn(ArrowDown, "Send backward", () => ed.restack(ids, -1), "["),
      btn(
        ChevronsDown,
        "Send to back",
        () => ed.restack(ids, -Infinity),
        "Ctrl ["
      )
    ),
    group(
      btn(AlignHorizontalJustifyStart, "Align to the left edge", () =>
        ed.align("left")
      ),
      btn(AlignHorizontalJustifyCenter, "Center across", () =>
        ed.align("hcenter")
      ),
      btn(AlignHorizontalJustifyEnd, "Align to the right edge", () =>
        ed.align("right")
      ),
      btn(AlignVerticalJustifyStart, "Align to the top", () => ed.align("top")),
      btn(AlignVerticalJustifyCenter, "Center up and down", () =>
        ed.align("vcenter")
      ),
      btn(AlignVerticalJustifyEnd, "Align to the bottom", () =>
        ed.align("bottom")
      )
    ),
    group(
      btn(Copy, "Duplicate", () => ed.duplicate(), "Ctrl D"),
      btn(
        first?.locked ? Lock : LockOpen,
        first?.locked ? "Unlock" : "Lock",
        () => (ed.set(ids, { locked: !first.locked }), ed.commit()),
        undefined,
        !!first?.locked
      ),
      btn(
        first?.hidden ? EyeOff : Eye,
        first?.hidden ? "Show" : "Hide",
        () => (ed.set(ids, { hidden: !first.hidden }), ed.commit())
      ),
      btn(Trash2, "Delete", () => ed.remove(), "Del")
    ),
    h("div", { class: "spacer" })
  );
  zoombar.replaceChildren(
    tipBtn(Minus, "Zoom out", () => ed.zoomTo(ed.zoom / 1.25), {
      key: "Ctrl -",
    }),
    h(
      "button",
      {
        class: "ie-zoom",
        "data-tip": "Zoom to 100%",
        "data-key": "1",
        "data-tip-pos": "below",
        onclick: () => ed.zoomTo(1),
      },
      `${Math.round(ed.zoom * 100)}%`
    ),
    tipBtn(Plus, "Zoom in", () => ed.zoomTo(ed.zoom * 1.25), {
      key: "Ctrl +",
    }),
    h(
      "button",
      {
        class: "btn btn-ghost btn-sm",
        "data-tip": "Fit the picture",
        "data-key": "Ctrl 0",
        onclick: () => ed.fit(),
      },
      "Fit"
    )
  );
}

// ---- left: layers, top of the stack first

function drawLayers() {
  const ed = st.editor!;
  const list = [...ed.doc.layers].reverse();
  layers.replaceChildren(
    h(
      "div",
      { class: "ie-panel-head" },
      h("span", {}, "Layers"),
      h("span", { class: "media-count" }, String(list.length)),
      h("div", { class: "spacer" }),
      tipBtn(ImagePlus, "Add a picture", addPictures)
    ),
    list.length
      ? h(
          "div",
          { class: "ip-layers" },
          ...list.map(l => {
            const toggleBtn = (
              ic: IconNode,
              tip: string,
              patch: Partial<Layer>,
              on: boolean
            ) =>
              h(
                "button",
                {
                  class: `icon-btn sm ip-layer-btn${on ? " on" : ""}`,
                  "data-tip": tip,
                  "aria-label": tip,
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    ed.set([l.id], patch);
                    ed.commit();
                  },
                },
                icon(ic, 14)
              );
            return h(
              "div",
              {
                class: `ip-layer${ed.sel.includes(l.id) ? " active" : ""}${l.hidden ? " off" : ""}`,
                onclick: (e: MouseEvent) =>
                  ed.select(
                    e.shiftKey || e.ctrlKey
                      ? ed.sel.includes(l.id)
                        ? ed.sel.filter(x => x !== l.id)
                        : [...ed.sel, l.id]
                      : [l.id]
                  ),
              },
              h(
                "span",
                { class: "ip-layer-icon" },
                icon(KIND_ICON[l.kind], 14)
              ),
              h(
                "span",
                { class: "ip-layer-name" },
                l.kind === "text"
                  ? l.text.split("\n")[0].slice(0, 32) || l.name
                  : l.name
              ),
              toggleBtn(
                l.hidden ? EyeOff : Eye,
                l.hidden ? "Show" : "Hide",
                { hidden: !l.hidden },
                l.hidden
              ),
              toggleBtn(
                l.locked ? Lock : LockOpen,
                l.locked ? "Unlock" : "Lock",
                { locked: !l.locked },
                l.locked
              )
            );
          })
        )
      : h(
          "div",
          { class: "ie-empty dim small" },
          "Pick a tool on the left and draw, or paste a picture with Ctrl V."
        )
  );
}

// ---- right: properties of the selection, or of the picture itself

const field = (label: string, ...controls: (Node | null)[]) =>
  h(
    "div",
    { class: "ip-row" },
    h("span", { class: "ip-label" }, label),
    h("div", { class: "ip-ctl" }, ...controls)
  );

const section = (title: string, ...rows: (Node | null)[]) =>
  h(
    "div",
    { class: "ip-section" },
    h("div", { class: "ip-title" }, title),
    ...(rows.filter(Boolean) as Node[])
  );

function drawProps() {
  const ed = st.editor!;
  const scroll = props.scrollTop;
  props.replaceChildren(
    ...(ed.selected.length ? layerProps(ed) : pictureProps(ed))
  );
  props.scrollTop = scroll;
}

function layerProps(ed: ImageEditor) {
  const sel = ed.selected;
  const ids = sel.map(l => l.id);
  const first = sel[0];
  const one = sel.length === 1 ? first : null;

  const num = (
    value: number,
    apply: (v: number) => void,
    o: { min?: number; max?: number; suffix?: string } = {}
  ) =>
    h(
      "label",
      { class: "num-field" },
      h("input", {
        class: "input input-sm",
        type: "number",
        value: String(Math.round(value * 10) / 10),
        min: o.min != null ? String(o.min) : null,
        max: o.max != null ? String(o.max) : null,
        onchange: (e: Event) => {
          let v = parseFloat((e.target as HTMLInputElement).value);
          if (!isFinite(v)) return;
          if (o.min != null) v = Math.max(o.min, v);
          if (o.max != null) v = Math.min(o.max, v);
          apply(v);
          ed.commit();
        },
      }),
      o.suffix ? h("span", { class: "num-suffix" }, o.suffix) : null
    );

  const color = (
    value: string | null,
    fallback: string,
    apply: (v: string | null) => void
  ) =>
    h(
      "div",
      { class: "inline" },
      toggle(value !== null, on => (apply(on ? fallback : null), ed.commit())),
      h("input", {
        class: "color-input",
        type: "color",
        value: value ?? fallback,
        disabled: value === null,
        oninput: (e: Event) => apply((e.target as HTMLInputElement).value),
        onchange: () => ed.commit(),
      })
    );

  const kinds = new Set(sel.map(l => l.kind));
  const strokeOnly = [...kinds].every(
    k => k === "line" || k === "arrow" || k === "path"
  );
  // pictures don't take a fill or an outline
  const pictures = [...kinds].every(k => k === "image");
  const out: Node[] = [];

  if (one)
    out.push(
      section(
        one.kind === "text"
          ? "Text"
          : one.kind === "image"
            ? "Picture"
            : "Shape",
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
          num(one.x, v => ed.set(ids, { x: v }), { suffix: "X" }),
          num(one.y, v => ed.set(ids, { y: v }), { suffix: "Y" })
        ),
        one.kind === "text"
          ? null
          : field(
              "Size",
              num(one.w, v => ed.set(ids, { w: v }), { min: 1, suffix: "W" }),
              num(one.h, v => ed.set(ids, { h: v }), { min: 0, suffix: "H" })
            ),
        field(
          "Rotation",
          num(ImageEditor.normRot(one.rot), v => ed.set(ids, { rot: v }), {
            suffix: "°",
          })
        )
      )
    );

  if (one?.kind === "text")
    out.push(
      section(
        "Type",
        h("textarea", {
          class: "input ie-textarea",
          rows: "3",
          spellcheck: "false",
          value: one.text,
          oninput: (e: Event) =>
            ed.set(ids, {
              text: (e.target as HTMLTextAreaElement).value || " ",
            }),
          onchange: () => ed.commit(),
        }),
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
          })()
        ),
        field(
          "Size",
          num(one.size, v => ed.set(ids, { size: v }), {
            min: 6,
            max: 1000,
            suffix: "px",
          }),
          tipBtn(
            Bold,
            "Bold",
            () => (ed.set(ids, { bold: !one.bold }), ed.commit()),
            { on: one.bold }
          )
        ),
        field(
          "Align",
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
      )
    );

  out.push(
    section(
      "Look",
      strokeOnly || pictures
        ? null
        : field(
            "Fill",
            color(first.fill, store.settings.images.fill, v =>
              ed.set(ids, { fill: v })
            )
          ),
      pictures
        ? null
        : field(
            strokeOnly ? "Color" : "Outline",
            color(first.stroke, store.settings.images.stroke, v =>
              ed.set(ids, { stroke: v })
            ),
            num(first.sw, v => ed.set(ids, { sw: v }), {
              min: 0,
              max: 200,
              suffix: "px",
            })
          ),
      kinds.has("rect")
        ? field(
            "Corners",
            num(first.radius, v => ed.set(ids, { radius: v }), {
              min: 0,
              suffix: "px",
            })
          )
        : null,
      field(
        "Opacity",
        h(
          "div",
          { class: "gain-row" },
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
          }),
          h(
            "span",
            { class: "value-label" },
            `${Math.round(first.opacity * 100)}%`
          )
        )
      )
    )
  );
  return out;
}

function pictureProps(ed: ImageEditor) {
  const d = ed.doc;
  const c = st.cur;
  const dim = (key: "w" | "h") =>
    h(
      "label",
      { class: "num-field" },
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
      }),
      h("span", { class: "num-suffix" }, key === "w" ? "W" : "H")
    );
  const tagCount = Object.keys(ed.meta.tags).length;
  return [
    section(
      "Picture",
      field(
        "Name",
        h("input", {
          class: "input input-sm",
          value: c.name,
          spellcheck: "false",
          onchange: (e: Event) => {
            c.name = (e.target as HTMLInputElement).value.trim() || "Untitled";
            redraw.chrome();
          },
        })
      ),
      field(
        "Category",
        h("input", {
          class: "input input-sm",
          list: "img-cat-list-ed",
          value: c.category,
          placeholder: "Uncategorized",
          spellcheck: "false",
          onchange: (e: Event) =>
            (c.category = (e.target as HTMLInputElement).value.trim()),
        }),
        h(
          "datalist",
          { id: "img-cat-list-ed" },
          ...categories().map(([x]) => h("option", { value: x }))
        )
      ),
      field(
        "Tags",
        h("input", {
          class: "input input-sm",
          value: c.tags.join(", "),
          placeholder: "comma, separated",
          spellcheck: "false",
          onchange: (e: Event) =>
            (c.tags = (e.target as HTMLInputElement).value
              .split(",")
              .map(t => t.trim())
              .filter(Boolean)),
        })
      )
    ),
    section(
      "Canvas",
      field("Size", dim("w"), dim("h")),
      h(
        "div",
        { class: "swatches" },
        ...BACKGROUNDS.map(b =>
          h("button", {
            class: `swatch${JSON.stringify(b.bg) === JSON.stringify(d.bg) ? " active" : ""}${b.bg === null ? " clear" : ""}`,
            style: swatchStyle(b.bg),
            title: b.label,
            "aria-label": b.label,
            onclick: () => (ed.setDoc({ bg: b.bg }), ed.commit()),
          })
        ),
        h("input", {
          class: "color-input",
          type: "color",
          title: "Pick a color",
          value: typeof d.bg === "string" ? d.bg : "#ffffff",
          oninput: (e: Event) =>
            ed.setDoc({ bg: (e.target as HTMLInputElement).value }),
          onchange: () => ed.commit(),
        })
      )
    ),
    section(
      "Metadata",
      h(
        "div",
        { class: "ip-note" },
        ed.meta.strip
          ? "Left out of exported files."
          : tagCount
            ? `${tagCount} ${tagCount === 1 ? "tag" : "tags"} go into exported PNG and JPEG files.`
            : "Title, author, date and more for exported PNG and JPEG files."
      ),
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm",
          onclick: () =>
            openMetadata({ path: null, name: c.name, edit: ed, kind: "image" }),
        },
        "Edit metadata…"
      )
    ),
    h(
      "div",
      { class: "ie-hint dim small" },
      "Select a layer to change it. Shift-click to pick more than one."
    ),
  ];
}
