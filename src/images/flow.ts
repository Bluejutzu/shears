import { Check, Film, FolderOpen, Images, Plus, Send, X } from "lucide";

import { fileUrl } from "../shared/api";
import { saveSettings, store } from "../shared/settings";
import { h, icon, modal, segmented, toggle } from "../shared/ui";
import { searchBox } from "./bits";
import {
  filtered,
  itemById,
  pathOf,
  thumbUrl,
  type ImageItem,
} from "./library";

/** Where and when images land on the video. */
export type Placement = {
  start: "playhead" | "start" | number;
  /** one after another instead of all at the same time */
  sequence: boolean;
  seconds: number;
  /** -1, 0 or 1 across and down: a corner, an edge or the middle */
  anchor: [number, number];
  /** width as a fraction of the frame */
  scale: number;
  fill: boolean;
};

export type Video = {
  path: string;
  name: string;
  current: boolean;
  thumb?: string;
};

export type FlowHost = {
  videos: () => Video[];
  browseVideo: () => Promise<string | null>;
  send: (
    images: { path: string; name: string }[],
    video: string,
    p: Placement
  ) => Promise<void>;
};

// kept between visits so leaving the page doesn't lose what you set up
let chosen: string[] = [];
let video: string | null = null;
const place: Placement = {
  start: "playhead",
  sequence: false,
  seconds: 5,
  anchor: [0, 0],
  scale: 0.5,
  fill: false,
};
const extra: Video[] = [];

/** Start the flow with these library images picked. */
export function flowPreselect(ids: string[]) {
  chosen = [...ids];
}

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
const MARGIN = 0.04; // keep in step with addImage in video/editor.ts

/** Where an image of this shape sits in a 16:9 frame, as fractions of the frame. */
function spot(aspect: number) {
  const w = place.fill ? 1 : place.scale;
  const hgt = (w * (16 / 9)) / aspect;
  const m = place.fill ? 0 : MARGIN;
  const x = place.fill ? 0.5 : 0.5 + place.anchor[0] * (0.5 - w / 2 - m);
  const y = place.fill ? 0.5 : 0.5 + place.anchor[1] * (0.5 - hgt / 2 - m);
  return { left: x - w / 2, top: y - hgt / 2, w, hgt };
}

export function renderFlow(root: HTMLElement, host: FlowHost) {
  place.seconds = store.settings.images.seconds;
  const videos = () => [
    ...extra.filter(v => !host.videos().some(x => x.path === v.path)),
    ...host.videos(),
  ];
  if (!video || !videos().some(v => v.path === video))
    video = videos()[0]?.path ?? null;
  chosen = chosen.filter(id => itemById(id));

  const stage = h("div", { class: "fl-stage" });
  const tray = h("div", { class: "fl-tray" });
  const panel = h("aside", { class: "fl-panel" });
  const summary = h("div", { class: "fl-summary" });
  const go = h("button", { class: "btn btn-primary fl-go" });

  const picked = () => chosen.flatMap(id => itemById(id) ?? []);
  const current = () => videos().find(v => v.path === video);
  const all = () => (drawStage(), drawTray(), drawPanel(), drawFoot());

  // ---- the preview: the video's frame with the images where they'll land

  function drawStage() {
    const v = current();
    const list = picked();
    const first = list[0];
    const zones: Node[] = [];
    for (const ay of [-1, 0, 1])
      for (const ax of [-1, 0, 1])
        zones.push(
          h("button", {
            class: `fl-zone${!place.fill && place.anchor[0] === ax && place.anchor[1] === ay ? " active" : ""}`,
            "aria-label": "Put the images here",
            onclick: () => {
              place.anchor = [ax, ay];
              place.fill = false;
              all();
            },
          })
        );
    let shown: Node | null = null;
    if (first) {
      const s = spot(first.w / first.h);
      shown = h(
        "div",
        {
          class: "fl-spot",
          style: `left:${s.left * 100}%;top:${s.top * 100}%;width:${s.w * 100}%;height:${s.hgt * 100}%`,
        },
        h("img", { src: thumbUrl(first), alt: "", draggable: "false" }),
        list.length > 1
          ? h(
              "span",
              { class: "fl-count" },
              place.sequence ? `1 of ${list.length}` : `+${list.length - 1}`
            )
          : null
      );
    }
    stage.replaceChildren(
      h(
        "div",
        { class: "fl-frame" },
        v?.thumb
          ? h("img", {
              class: "fl-frame-bg",
              src: fileUrl(v.thumb),
              alt: "",
              draggable: "false",
            })
          : h("div", { class: "fl-frame-empty" }, icon(Film, 28, 1.25)),
        shown ??
          h("div", { class: "fl-frame-hint" }, "Your images show up here"),
        h("div", { class: "fl-zones" }, ...zones)
      ),
      h(
        "div",
        { class: "fl-stage-caption" },
        place.fill
          ? "Filling the whole frame"
          : "Click a spot on the frame to move the images there"
      )
    );
  }

  // ---- the picked images

  async function addImages() {
    const res = await pickFromLibrary(chosen);
    if (res) {
      chosen = res.map(r => r.id);
      all();
    }
  }

  function drawTray() {
    const list = picked();
    tray.replaceChildren(
      h(
        "div",
        { class: "fl-tray-head" },
        h("span", { class: "fl-tray-title" }, "Images"),
        h("span", { class: "media-count" }, String(list.length)),
        h("div", { class: "spacer" }),
        list.length
          ? h(
              "button",
              {
                class: "btn btn-ghost btn-sm",
                onclick: () => ((chosen = []), all()),
              },
              "Clear"
            )
          : null,
        h(
          "button",
          { class: "btn btn-secondary btn-sm", onclick: addImages },
          icon(Plus, 14),
          list.length ? "Add or change" : "Pick images"
        )
      ),
      list.length
        ? h(
            "div",
            { class: "fl-chips" },
            ...list.map((i, n) =>
              h(
                "div",
                { class: "fl-chip", title: `${i.name} · ${i.w}×${i.h}` },
                place.sequence
                  ? h("span", { class: "fl-chip-n" }, String(n + 1))
                  : null,
                h(
                  "div",
                  { class: "fl-chip-img" },
                  h("img", { src: thumbUrl(i), alt: "", draggable: "false" })
                ),
                h("span", { class: "fl-chip-name" }, i.name),
                h(
                  "button",
                  {
                    class: "icon-btn sm",
                    "aria-label": `Remove ${i.name}`,
                    onclick: () => {
                      chosen = chosen.filter(id => id !== i.id);
                      all();
                    },
                  },
                  icon(X, 13)
                )
              )
            )
          )
        : h(
            "button",
            { class: "fl-tray-empty", onclick: addImages },
            icon(Images, 22, 1.5),
            h("span", {}, "Pick the images to put on the video")
          )
    );
  }

  // ---- video, timing and size

  function drawPanel() {
    const v = current();
    const startMode = typeof place.start === "number" ? "time" : place.start;
    const section = (title: string, ...kids: (Node | null)[]) =>
      h(
        "div",
        { class: "fl-sec" },
        h("div", { class: "fl-sec-title" }, title),
        ...(kids.filter(Boolean) as Node[])
      );
    const seconds = (value: number, set: (v: number) => void, min = 0) =>
      h(
        "div",
        { class: "num-field" },
        h("input", {
          class: "input",
          type: "number",
          min: String(min),
          step: "0.5",
          value: String(value),
          onchange: (e: Event) => {
            set(Math.max(min, +(e.target as HTMLInputElement).value || min));
            drawFoot();
          },
        }),
        h("span", { class: "num-suffix" }, "s")
      );
    const size = h(
      "span",
      { class: "value-label" },
      `${Math.round(place.scale * 100)}%`
    );

    panel.replaceChildren(
      section(
        "Video",
        h(
          "button",
          {
            class: "fl-video-pick",
            onclick: () => pickVideo(host, videos, p => ((video = p), all())),
          },
          h(
            "div",
            { class: "fl-video-thumb" },
            v?.thumb
              ? h("img", { src: fileUrl(v.thumb), alt: "", draggable: "false" })
              : icon(Film, 16, 1.5)
          ),
          h(
            "div",
            { class: "fl-video-text" },
            h("div", { class: "fl-video-name" }, v?.name ?? "No video picked"),
            h(
              "div",
              { class: "fl-video-sub" },
              v
                ? v.current
                  ? "Open in the video editor"
                  : "Opens in the video editor"
                : "Choose one to continue"
            )
          ),
          h("span", { class: "fl-change" }, "Change")
        )
      ),
      section(
        "When",
        h(
          "label",
          { class: "fl-field" },
          h("span", {}, "Starts"),
          h(
            "select",
            {
              class: "input",
              onchange: (e: Event) => {
                const m = (e.target as HTMLSelectElement).value;
                place.start = m === "time" ? 0 : (m as "playhead" | "start");
                all();
              },
            },
            h(
              "option",
              { value: "playhead", selected: startMode === "playhead" },
              "At the playhead"
            ),
            h(
              "option",
              { value: "start", selected: startMode === "start" },
              "At the beginning"
            ),
            h(
              "option",
              { value: "time", selected: startMode === "time" },
              "At a set time"
            )
          )
        ),
        typeof place.start === "number"
          ? h(
              "label",
              { class: "fl-field" },
              h("span", {}, "Time"),
              seconds(place.start, v => (place.start = v))
            )
          : null,
        h(
          "label",
          { class: "fl-field" },
          h("span", {}, "Each shows"),
          seconds(
            place.seconds,
            v => {
              place.seconds = store.settings.images.seconds = v;
              saveSettings();
            },
            0.5
          )
        ),
        h(
          "div",
          { class: "fl-field" },
          h("span", {}, "Order"),
          segmented(
            [
              { label: "Together", value: false },
              { label: "One by one", value: true },
            ],
            place.sequence,
            s => ((place.sequence = s), all())
          )
        )
      ),
      section(
        "Size",
        h(
          "div",
          { class: "fl-field" },
          h("span", {}, "Fill frame"),
          toggle(place.fill, on => ((place.fill = on), all()))
        ),
        place.fill
          ? null
          : h(
              "div",
              { class: "fl-field" },
              h("span", {}, "Width"),
              h(
                "div",
                { class: "gain-row" },
                h("input", {
                  class: "range",
                  type: "range",
                  min: "10",
                  max: "100",
                  value: String(Math.round(place.scale * 100)),
                  oninput: (e: Event) => {
                    place.scale = +(e.target as HTMLInputElement).value / 100;
                    size.textContent = `${Math.round(place.scale * 100)}%`;
                    drawStage();
                  },
                }),
                size
              )
            )
      )
    );
  }

  function drawFoot() {
    const n = chosen.length;
    const v = current();
    const when =
      place.start === "playhead"
        ? "at the playhead"
        : place.start === "start"
          ? "from the beginning"
          : `${place.start}s in`;
    summary.textContent = !n
      ? "Pick at least one image."
      : !v
        ? "Pick a video to put them on."
        : `${n} ${n === 1 ? "image" : "images"} on ${v.name}, ${when}${n > 1 ? (place.sequence ? `, one after another (${n * place.seconds}s in all)` : ", all at once") : ""}. Each gets its own image track.`;
    go.disabled = !n || !v;
    go.replaceChildren(
      icon(Send, 15),
      n > 1 ? `Add ${n} images to the video` : "Add to the video"
    );
  }

  go.onclick = async () => {
    const list = picked();
    if (!list.length || !video) return;
    await host.send(
      list.map(i => ({ path: pathOf(i.id), name: i.name })),
      video,
      { ...place }
    );
  };

  root.replaceChildren(
    h(
      "div",
      { class: "fl" },
      h(
        "div",
        { class: "page-head" },
        h("h1", {}, "Send to video"),
        h(
          "div",
          { class: "page-sub" },
          "Put library images on a video. You can still move and resize them in the video editor."
        )
      ),
      h(
        "div",
        { class: "fl-body" },
        h("div", { class: "fl-main" }, stage, tray),
        panel
      ),
      h("div", { class: "fl-foot" }, summary, go)
    )
  );
  all();
}

/** Choose the video in a dialog: the open one, recents, the media pool, or a file. */
function pickVideo(
  host: FlowHost,
  videos: () => Video[],
  done: (path: string) => void
) {
  let q = "";
  const list = h("div", { class: "pick-list" });
  const body = h("div", { class: "form" });
  const { close } = modal("Choose a video", body);
  const draw = () => {
    const w = words(q);
    const rows = videos().filter(v =>
      w.every(x => v.name.toLowerCase().includes(x))
    );
    list.replaceChildren(
      ...(rows.length
        ? rows.slice(0, 100).map(v =>
            h(
              "button",
              {
                class: "fl-video",
                title: v.path,
                onclick: () => {
                  close();
                  done(v.path);
                },
              },
              h(
                "div",
                { class: "fl-video-thumb" },
                v.thumb
                  ? h("img", {
                      src: fileUrl(v.thumb),
                      alt: "",
                      draggable: "false",
                    })
                  : icon(Film, 16, 1.5)
              ),
              h("span", { class: "fl-video-name" }, v.name),
              v.current ? h("span", { class: "fl-badge" }, "Open") : null
            )
          )
        : [
            h(
              "div",
              { class: "fl-none dim small" },
              videos().length
                ? "No video matches"
                : "No videos yet. Browse for one."
            ),
          ])
    );
  };
  body.append(
    h(
      "div",
      { class: "inline" },
      h(
        "div",
        { style: "flex:1" },
        searchBox(q, "Search videos", v => ((q = v), draw()))
      ),
      h(
        "button",
        {
          class: "btn btn-secondary btn-sm",
          onclick: async () => {
            const f = await host.browseVideo();
            if (!f) return;
            if (!videos().some(v => v.path === f))
              extra.unshift({
                path: f,
                name: f.split(/[\\/]/).pop()!,
                current: false,
              });
            close();
            done(f);
          },
        },
        icon(FolderOpen, 14),
        "Browse…"
      )
    ),
    list
  );
  draw();
}

function imageGrid(list: ImageItem[], picked: Set<string>, redraw: () => void) {
  return list.length
    ? h(
        "div",
        { class: "fl-grid" },
        ...list.map(i =>
          h(
            "button",
            {
              class: `fl-pic${picked.has(i.id) ? " picked" : ""}`,
              title: `${i.name} · ${i.w}×${i.h}`,
              onclick: () => {
                if (picked.has(i.id)) picked.delete(i.id);
                else picked.add(i.id);
                redraw();
              },
            },
            h(
              "div",
              { class: "fl-pic-img" },
              h("img", {
                src: thumbUrl(i),
                alt: "",
                draggable: "false",
                loading: "lazy",
              }),
              h(
                "span",
                { class: "img-check" },
                picked.has(i.id) ? icon(Check, 13, 2.5) : null
              )
            ),
            h("div", { class: "fl-pic-name" }, i.name)
          )
        )
      )
    : h(
        "div",
        { class: "fl-none dim small" },
        "No images match. Make some in the library first."
      );
}

/**
 * Pick library images in a dialog, starting with `preselect` ticked. Resolves with the picked
 * images in the order they were picked, or null when cancelled.
 */
export function pickFromLibrary(
  preselect: string[] = []
): Promise<{ id: string; path: string; name: string }[] | null> {
  return new Promise(resolve => {
    const picked = new Set(preselect);
    let query = "";
    let result: { id: string; path: string; name: string }[] | null = null;
    const body = h("div", { class: "form pick-lib" });
    const { close } = modal("Image library", body, {
      wide: true,
      onClose: () => void resolve(result),
    });
    const draw = () => {
      const list = filtered({ q: query, category: null, sort: "new" });
      body.replaceChildren(
        searchBox(query, "Search images", v => {
          query = v;
          draw();
          body.querySelector<HTMLInputElement>("input")?.focus();
        }),
        imageGrid(list, picked, draw),
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
              disabled: !picked.size && !preselect.length,
              onclick: () => {
                result = [...picked].flatMap(id => {
                  const i = itemById(id);
                  return i ? [{ id, path: pathOf(id), name: i.name }] : [];
                });
                close();
              },
            },
            picked.size > 1
              ? `Use ${picked.size} images`
              : picked.size
                ? "Use 1 image"
                : "Use none"
          )
        )
      );
    };
    draw();
  });
}
