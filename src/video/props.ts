import {
  AudioLines,
  Film,
  FolderOpen,
  GripVertical,
  Image,
  ImagePlus,
  Info,
  Link2,
  Link2Off,
  Plus,
  Tags,
  Trash,
} from "lucide";

import { api, type Probe } from "../shared/api";
import {
  basename,
  dirname,
  fmt,
  fmtSize,
  h,
  icon,
  modal,
  segmented,
  toggle,
} from "../shared/ui";
import type { Edit, Look, Overlay, Track } from "./edit";

type Ctx = {
  path: string;
  probe: Probe;
  edit: Edit;
  addTrack: () => void;
  addImage: () => void;
  showInfo: () => void;
  showMetadata: () => void;
};

export type InspectorTab = "video" | "image" | "audio";
type Tab = InspectorTab;
let activeTab: Tab = "video";

/** Switch tabs from outside, like "Show in Inspector" in a right-click menu. */
export function setInspectorTab(tab: Tab) {
  activeTab = tab;
}

const kv = (k: string, v: string) =>
  h(
    "div",
    { class: "kv" },
    h("span", { class: "dim" }, k),
    h("span", { title: v }, v)
  );

function trackCard(t: Track, n: number, e: Edit) {
  const setGain = (db: number) => {
    t.gainDb = Math.round(Math.min(Math.max(db, -30), 12) * 10) / 10;
    e.onChange();
  };
  const flag = (
    label: string | Node,
    on: boolean,
    cls: string,
    tip: string,
    patch: Partial<Track>
  ) =>
    h(
      "button",
      {
        class: `tl-flag ${cls}${on ? " on" : ""}`,
        "data-tip": tip,
        onclick: () => e.updateTrack(t.id, patch),
      },
      label
    );

  return h(
    "div",
    { class: "track-card", "data-track": t.id },
    h(
      "div",
      { class: "track-card-head" },
      h("span", { class: "tl-tag" }, `A${n}`),
      h("input", {
        class: "input input-ghost",
        value: t.name,
        spellcheck: "false",
        onchange: (ev: Event) =>
          e.updateTrack(t.id, {
            name: (ev.target as HTMLInputElement).value.trim() || t.name,
          }),
      }),
      flag(
        icon(t.linked ? Link2 : Link2Off, 12),
        t.linked,
        "link",
        t.linked ? "Linked to the video" : "Not linked",
        { linked: !t.linked }
      ),
      flag("M", t.muted, "mute", "Mute track", { muted: !t.muted }),
      flag("S", t.solo, "solo", "Solo (preview only)", { solo: !t.solo })
    ),
    h(
      "div",
      { class: "gain-row" },
      h("span", { class: "dim small label-w" }, "Volume"),
      h("input", {
        class: "range",
        type: "range",
        min: "-30",
        max: "12",
        step: "0.1",
        value: String(t.gainDb),
        onpointerdown: () => e.checkpoint(),
        oninput: (ev: Event) => setGain(+(ev.target as HTMLInputElement).value),
        ondblclick: () => e.updateTrack(t.id, { gainDb: 0 }),
      }),
      h(
        "label",
        { class: "num-input" },
        h("input", {
          type: "number",
          step: "0.5",
          min: "-30",
          max: "12",
          value: t.gainDb.toFixed(1),
          onchange: (ev: Event) => {
            const v = parseFloat((ev.target as HTMLInputElement).value);
            if (isFinite(v))
              e.updateTrack(t.id, {
                gainDb: Math.round(Math.min(Math.max(v, -30), 12) * 10) / 10,
              });
          },
        }),
        h("span", { class: "dim" }, "dB")
      )
    ),
    t.kind === "file"
      ? h(
          "div",
          { class: "gain-row" },
          h("span", { class: "dim small label-w" }, "Starts at"),
          h(
            "label",
            { class: "num-input wide" },
            h("input", {
              type: "number",
              step: "0.1",
              value: t.offset.toFixed(2),
              onchange: (ev: Event) => {
                const v = parseFloat((ev.target as HTMLInputElement).value);
                if (isFinite(v)) e.updateTrack(t.id, { offset: v });
              },
            }),
            h("span", { class: "dim" }, "s")
          ),
          h("div", { class: "spacer" }),
          h(
            "button",
            {
              class: "icon-btn sm",
              "data-tip": "Show file",
              onclick: () => api.reveal(t.path),
            },
            icon(FolderOpen, 14)
          ),
          h(
            "button",
            {
              class: "icon-btn sm danger",
              "data-tip": "Remove track",
              onclick: () => e.removeTrack(t.id),
            },
            icon(Trash, 14)
          )
        )
      : null,
    h(
      "div",
      { class: "track-sub dim small", title: t.path },
      t.kind === "file"
        ? `${basename(t.path)} · ${fmt(t.duration, false)}`
        : `${t.codec.toUpperCase()} · from the video`
    )
  );
}

/** A slider with a number box. Shown as value * k (so 0.5 can read as 50%). */
function sliderRow(
  e: Edit,
  label: string,
  value: number,
  opts: { min: number; max: number; step: number; unit: string; k?: number },
  set: (v: number) => void,
  commit: (v: number) => void
) {
  const k = opts.k ?? 1;
  const clampV = (v: number) => Math.min(Math.max(v, opts.min), opts.max);
  return h(
    "div",
    { class: "gain-row" },
    h("span", { class: "dim small label-w" }, label),
    h("input", {
      class: "range",
      type: "range",
      min: String(opts.min),
      max: String(opts.max),
      step: String(opts.step),
      value: String(value * k),
      onpointerdown: () => e.checkpoint(),
      oninput: (ev: Event) => {
        set(+(ev.target as HTMLInputElement).value / k);
        e.onChange();
      },
    }),
    h(
      "label",
      { class: "num-input" },
      h("input", {
        type: "number",
        step: String(opts.step),
        min: String(opts.min),
        max: String(opts.max),
        value: String(Math.round(value * k * 10) / 10),
        onchange: (ev: Event) => {
          const v = parseFloat((ev.target as HTMLInputElement).value);
          if (isFinite(v)) commit(clampV(v) / k);
        },
      }),
      h("span", { class: "dim" }, opts.unit)
    )
  );
}

function imageCard(o: Overlay, n: number, e: Edit) {
  const set = (patch: Partial<Overlay>) => e.updateOverlay(o.id, patch);
  const secs = (tip: string, value: number, apply: (v: number) => void) =>
    h(
      "label",
      { class: "num-input wide", "data-tip": tip },
      h("input", {
        type: "number",
        step: "0.1",
        min: "0",
        value: value.toFixed(2),
        onchange: (ev: Event) => {
          const v = parseFloat((ev.target as HTMLInputElement).value);
          if (isFinite(v) && v >= 0) apply(Math.round(v * 1000) / 1000);
        },
      }),
      h("span", { class: "dim" }, "s")
    );
  return h(
    "div",
    { class: "track-card", "data-track": o.id },
    h(
      "div",
      { class: "track-card-head" },
      h("span", { class: "tl-tag" }, `V${n}`),
      h("input", {
        class: "input input-ghost",
        value: o.name,
        spellcheck: "false",
        onchange: (ev: Event) =>
          set({ name: (ev.target as HTMLInputElement).value.trim() || o.name }),
      }),
      h(
        "button",
        {
          class: "icon-btn sm",
          "data-tip": "Show file",
          onclick: () => api.reveal(o.path),
        },
        icon(FolderOpen, 14)
      ),
      h(
        "button",
        {
          class: "icon-btn sm danger",
          "data-tip": "Delete image",
          onclick: () => e.removeItems([o.id]),
        },
        icon(Trash, 14)
      )
    ),
    sliderRow(
      e,
      "Size",
      o.scale,
      { min: 2, max: 300, step: 1, unit: "%", k: 100 },
      v => (o.scale = v),
      v => set({ scale: v })
    ),
    sliderRow(
      e,
      "Opacity",
      o.opacity,
      { min: 0, max: 100, step: 1, unit: "%", k: 100 },
      v => (o.opacity = v),
      v => set({ opacity: v })
    ),
    sliderRow(
      e,
      "Across",
      o.x,
      { min: 0, max: 100, step: 0.5, unit: "%", k: 100 },
      v => (o.x = v),
      v => set({ x: v })
    ),
    sliderRow(
      e,
      "Down",
      o.y,
      { min: 0, max: 100, step: 0.5, unit: "%", k: 100 },
      v => (o.y = v),
      v => set({ y: v })
    ),
    h(
      "div",
      { class: "gain-row" },
      h("span", { class: "dim small label-w" }, "From"),
      secs("Starts at", o.start, v =>
        set({ start: Math.min(v, e.duration - 0.1) })
      ),
      h("span", { class: "dim small" }, "for"),
      secs("Length", o.duration, v => set({ duration: Math.max(0.1, v) }))
    ),
    h(
      "div",
      { class: "track-sub dim small", title: o.path },
      `${basename(o.path)} · ${fmt(o.start, false)} – ${fmt(o.start + o.duration, false)}`
    )
  );
}

/** Slide cards from where they were to where they are now, so reordering doesn't just snap. */
function animateMoves(el: HTMLElement, before: Map<string, DOMRect>) {
  for (const card of el.querySelectorAll<HTMLElement>("[data-track]")) {
    const old = before.get(card.dataset.track!);
    if (!old) continue;
    const dy = old.top - card.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    card.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" }
    );
  }
}

export function renderProps(el: HTMLElement, ctx: Ctx) {
  const { edit: e } = ctx;
  const look = e.look;
  const selAudio = e.tracks.filter(t => e.isSelected(t.id));
  const selImages = e.overlays.filter(o => e.isSelected(o.id));
  const has: Record<Tab, boolean> = {
    video: e.isSelected("video"),
    image: selImages.length > 0,
    audio: selAudio.length > 0,
  };
  if (!has[activeTab])
    activeTab =
      (["video", "image", "audio"] as Tab[]).find(t => has[t]) ?? "video";
  const nothing = !has.video && !has.image && !has.audio;

  const before = new Map<string, DOMRect>();
  for (const card of el.querySelectorAll<HTMLElement>("[data-track]"))
    before.set(card.dataset.track!, card.getBoundingClientRect());
  const scroll = el.scrollTop;

  const tab = (id: Tab, ic: typeof Film, label: string) =>
    h(
      "button",
      {
        class: `insp-tab${activeTab === id && !nothing ? " active" : ""}`,
        disabled: !has[id],
        onclick: () => {
          activeTab = id;
          renderProps(el, ctx);
        },
      },
      icon(ic, 16),
      h("span", {}, label)
    );

  const videoTab = () => [
    h(
      "section",
      { class: "props-section" },
      h(
        "div",
        { class: "props-heading" },
        "Transform",
        h(
          "button",
          {
            class: "icon-btn sm",
            "data-tip": "Clip info",
            "data-key": "Ctrl I",
            onclick: ctx.showInfo,
          },
          icon(Info, 15)
        )
      ),
      h("div", { class: "props-label" }, "Rotate"),
      segmented<Look["rotate"]>(
        [
          { label: "0°", value: 0 },
          { label: "90°", value: 90 },
          { label: "180°", value: 180 },
          { label: "270°", value: 270 },
        ],
        look.rotate,
        rotate => e.setLook({ rotate })
      ),
      h(
        "div",
        { class: "props-inline" },
        h("span", {}, "Flip horizontally"),
        toggle(look.flip, flip => e.setLook({ flip }))
      )
    ),
    h(
      "section",
      { class: "props-section" },
      h("div", { class: "props-heading" }, "Metadata"),
      h(
        "div",
        { class: "form-hint" },
        e.meta.strip
          ? "All tags will be left out of exports."
          : Object.keys(e.meta.tags).length
            ? `${Object.keys(e.meta.tags).length} changed, applied when you export.`
            : "Title, date, location, device and more."
      ),
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm btn-block",
          "data-key": "Ctrl Shift M",
          onclick: ctx.showMetadata,
        },
        icon(Tags, 14),
        "Edit metadata"
      )
    ),
  ];

  const audioTab = () => [
    h(
      "div",
      { class: "track-list" },
      ...selAudio.map(t => trackCard(t, e.tracks.indexOf(t) + 1, e))
    ),
    h(
      "button",
      { class: "btn btn-secondary btn-sm btn-block", onclick: ctx.addTrack },
      icon(Plus, 14),
      "Add audio track"
    ),
    h(
      "div",
      { class: "form-hint" },
      "Drag the line inside a track to change its volume, double-click to reset. Mute leaves a track out of the export; solo is just for listening."
    ),
  ];

  const imageTab = () => [
    h(
      "div",
      { class: "track-list" },
      ...selImages.map(o => imageCard(o, e.overlays.indexOf(o) + 2, e))
    ),
    h(
      "button",
      { class: "btn btn-secondary btn-sm btn-block", onclick: ctx.addImage },
      icon(ImagePlus, 14),
      "Add image"
    ),
    h(
      "div",
      { class: "form-hint" },
      "Drag an image in the preview to move it (it snaps to the middle), or drag its corner to resize. Images are baked in when re-encoding."
    ),
  ];

  el.replaceChildren(
    h(
      "div",
      {
        class: "props-title",
        "data-tip": "Drag to move the inspector to the other side",
      },
      icon(GripVertical, 14),
      "Inspector"
    ),
    h(
      "div",
      { class: "insp-tabs" },
      tab("video", Film, "Video"),
      tab("image", Image, "Image"),
      tab("audio", AudioLines, "Audio")
    ),
    ...(nothing
      ? [
          h(
            "div",
            { class: "insp-empty" },
            "Select a clip in the timeline to see its properties.",
            h(
              "div",
              { class: "dim small" },
              "Linked tracks get selected together with the video. Ctrl-click to add to the selection."
            )
          ),
          h(
            "button",
            {
              class: "btn btn-secondary btn-sm btn-block",
              onclick: ctx.addTrack,
            },
            icon(Plus, 14),
            "Add audio track"
          ),
        ]
      : activeTab === "video"
        ? videoTab()
        : activeTab === "image"
          ? imageTab()
          : audioTab())
  );
  el.scrollTop = scroll;
  animateMoves(el, before);
}

export function showClipInfo(
  path: string,
  probe: Probe,
  tracks: Track[],
  editMetadata: () => void
) {
  const rotation = ((-probe.rotation % 360) + 360) % 360;
  const body = h(
    "div",
    { class: "clip-info" },
    h(
      "div",
      { class: "kv-grid" },
      kv("File", basename(path)),
      kv("Folder", dirname(path)),
      probe.container
        ? kv("Container", probe.container.split(",")[0].toUpperCase())
        : null,
      probe.size ? kv("Size", fmtSize(probe.size)) : null,
      kv("Length", fmt(probe.duration))
    ),
    h("div", { class: "props-label" }, "Video"),
    h(
      "div",
      { class: "kv-grid" },
      probe.width ? kv("Resolution", `${probe.width}×${probe.height}`) : null,
      probe.fps ? kv("Frame rate", `${+probe.fps.toFixed(3)} fps`) : null,
      probe.vcodec ? kv("Codec", probe.vcodec.toUpperCase()) : null,
      rotation ? kv("Rotation", `${rotation}°`) : null
    ),
    h(
      "div",
      { class: "props-label" },
      `Audio · ${probe.audio.length} ${probe.audio.length === 1 ? "track" : "tracks"}`
    ),
    h(
      "div",
      { class: "kv-grid" },
      ...(probe.audio.length
        ? probe.audio.map((a, i) =>
            kv(
              tracks.find(t => t.kind === "source" && t.index === i)?.name ??
                `Track ${i + 1}`,
              `${a.codec.toUpperCase()} · ${a.channels === 1 ? "mono" : a.channels === 2 ? "stereo" : `${a.channels} ch`}`
            )
          )
        : [h("span", { class: "dim" }, "No audio")])
    ),
    h(
      "div",
      { class: "modal-foot" },
      h(
        "button",
        { class: "btn btn-secondary", onclick: () => api.reveal(path) },
        icon(FolderOpen, 15),
        "Show in folder"
      ),
      h(
        "button",
        {
          class: "btn btn-primary",
          onclick: () => {
            close();
            editMetadata();
          },
        },
        icon(Tags, 15),
        "Edit metadata"
      )
    )
  );
  const { close } = modal("Clip info", body);
}
