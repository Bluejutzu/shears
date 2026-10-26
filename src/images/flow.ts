import { Check, Film, FolderOpen, Send } from "lucide";

import { fileUrl } from "../shared/api";
import { saveSettings, store } from "../shared/settings";
import { h, icon, modal, segmented, toggle } from "../shared/ui";
import { searchBox } from "./bits";
import { filtered, pathOf, thumbUrl, type ImageItem } from "./library";

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

let chosen = new Set<string>();
let video: string | null = null;
let q = "";
let vq = "";
const place: Placement = {
  start: "playhead",
  sequence: false,
  seconds: 5,
  anchor: [0, 0],
  scale: 0.5,
  fill: false,
};
let extra: Video[] = [];

/** Start the flow with these library images ticked. */
export function flowPreselect(ids: string[]) {
  chosen = new Set(ids);
}

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

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

export function renderFlow(root: HTMLElement, host: FlowHost) {
  place.seconds = store.settings.images.seconds;
  const videos = [
    ...extra.filter(v => !host.videos().some(x => x.path === v.path)),
    ...host.videos(),
  ];
  if (!video || !videos.some(v => v.path === video))
    video = videos[0]?.path ?? null;

  const imagesCol = h("div", { class: "fl-step" });
  const videoList = h("div", { class: "fl-videos" });
  const summary = h("div", { class: "fl-summary" });
  const go = h("button", { class: "btn btn-primary" });

  const drawImages = () => {
    const list = filtered({ q, category: null, sort: "new" });
    imagesCol.replaceChildren(
      h(
        "div",
        { class: "fl-step-head" },
        h("span", { class: "fl-num" }, "1"),
        h("span", { class: "fl-step-title" }, "Images"),
        h("span", { class: "media-count" }, `${chosen.size} picked`),
        h("div", { class: "spacer" }),
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            onclick: () => {
              const all = list.every(i => chosen.has(i.id));
              for (const i of list)
                all ? chosen.delete(i.id) : chosen.add(i.id);
              drawImages();
              drawFoot();
            },
          },
          list.length && list.every(i => chosen.has(i.id)) ? "None" : "All"
        )
      ),
      searchBox(q, "Search images", v => {
        q = v;
        drawImages();
        imagesCol.querySelector<HTMLInputElement>("input")?.focus();
      }),
      imageGrid(list, chosen, () => (drawImages(), drawFoot()))
    );
  };

  const drawVideos = () => {
    const w = words(vq);
    const rows = videos.filter(v =>
      w.every(x => v.name.toLowerCase().includes(x))
    );
    videoList.replaceChildren(
      ...(rows.length
        ? rows.slice(0, 80).map(v =>
            h(
              "button",
              {
                class: `fl-video${v.path === video ? " active" : ""}`,
                title: v.path,
                onclick: () => {
                  video = v.path;
                  drawVideos();
                  drawFoot();
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
              videos.length
                ? "No video matches"
                : "No videos yet. Browse for one."
            ),
          ])
    );
  };

  const preview = () => {
    // a 16:9 frame with the first image's spot drawn in (assuming a 16:9 picture)
    const s = place.fill ? 1 : place.scale;
    const hgt = s;
    const m = place.fill ? 0 : 0.04;
    const x = 0.5 + place.anchor[0] * (0.5 - s / 2 - m);
    const y = 0.5 + place.anchor[1] * (0.5 - hgt / 2 - m);
    return h(
      "div",
      { class: "fl-frame" },
      h("div", {
        class: "fl-spot",
        style: `left:${(x - s / 2) * 100}%;top:${(y - hgt / 2) * 100}%;width:${s * 100}%;height:${hgt * 100}%`,
      })
    );
  };

  const placeCol = h("div", { class: "fl-step" });
  const drawPlace = () => {
    const anchors: [number, number][] = [];
    for (const ay of [-1, 0, 1])
      for (const ax of [-1, 0, 1]) anchors.push([ax, ay]);
    placeCol.replaceChildren(
      h(
        "div",
        { class: "fl-step-head" },
        h("span", { class: "fl-num" }, "3"),
        h("span", { class: "fl-step-title" }, "Placement")
      ),
      h(
        "div",
        { class: "fl-field" },
        h("div", { class: "fl-label" }, "Starts"),
        segmented(
          [
            { label: "At the playhead", value: "playhead" as const },
            { label: "At the beginning", value: "start" as const },
            { label: "At a time", value: "time" as const },
          ],
          typeof place.start === "number" ? "time" : place.start,
          v => {
            place.start = v === "time" ? 0 : v;
            drawPlace();
            drawFoot();
          }
        ),
        typeof place.start === "number"
          ? h(
              "div",
              { class: "inline" },
              h("input", {
                class: "input input-sm",
                type: "number",
                min: "0",
                step: "0.5",
                value: String(place.start),
                onchange: (e: Event) => {
                  place.start = Math.max(
                    0,
                    +(e.target as HTMLInputElement).value || 0
                  );
                  drawFoot();
                },
              }),
              h("span", { class: "dim small" }, "seconds in")
            )
          : null
      ),
      h(
        "div",
        { class: "fl-field" },
        h("div", { class: "fl-label" }, "Timing"),
        segmented(
          [
            { label: "All at once", value: false },
            { label: "One after another", value: true },
          ],
          place.sequence,
          v => {
            place.sequence = v;
            drawFoot();
            drawPlace();
          }
        ),
        h(
          "div",
          { class: "inline" },
          h("span", { class: "dim small" }, "Each shows for"),
          h("input", {
            class: "input input-sm",
            type: "number",
            min: "0.5",
            step: "0.5",
            value: String(place.seconds),
            onchange: (e: Event) => {
              place.seconds = store.settings.images.seconds = Math.max(
                0.5,
                +(e.target as HTMLInputElement).value || 5
              );
              saveSettings();
              drawFoot();
            },
          }),
          h("span", { class: "dim small" }, "seconds")
        )
      ),
      h(
        "div",
        { class: "fl-field" },
        h("div", { class: "fl-label" }, "Position"),
        h(
          "div",
          { class: "fl-pos" },
          h(
            "div",
            { class: `fl-anchors${place.fill ? " off" : ""}` },
            ...anchors.map(a =>
              h("button", {
                class:
                  a[0] === place.anchor[0] && a[1] === place.anchor[1]
                    ? "active"
                    : "",
                "aria-label": "Put it here",
                onclick: () => {
                  place.anchor = a;
                  drawPlace();
                },
              })
            )
          ),
          preview()
        ),
        h(
          "div",
          { class: "inline" },
          toggle(place.fill, on => ((place.fill = on), drawPlace())),
          h("span", { class: "small" }, "Fill the whole frame")
        )
      ),
      place.fill
        ? ""
        : h(
            "div",
            { class: "fl-field" },
            h("div", { class: "fl-label" }, "Size"),
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
                  placeCol.querySelector(".fl-frame")?.replaceWith(preview());
                  (
                    placeCol.querySelector(".fl-size") as HTMLElement
                  ).textContent = `${Math.round(place.scale * 100)}% wide`;
                },
              }),
              h(
                "span",
                { class: "value-label fl-size" },
                `${Math.round(place.scale * 100)}% wide`
              )
            )
          )
    );
  };

  const drawFoot = () => {
    const n = chosen.size;
    const v = videos.find(x => x.path === video);
    const when =
      place.start === "playhead"
        ? "at the playhead"
        : place.start === "start"
          ? "at the beginning"
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
  };
  go.onclick = async () => {
    const ids = [...chosen];
    if (!ids.length || !video) return;
    const items = filtered({ q: "", category: null, sort: "new" }).filter(i =>
      chosen.has(i.id)
    );
    await host.send(
      items.map(i => ({ path: pathOf(i.id), name: i.name })),
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
          "Pick images from your library, choose a video, and decide where they go. You can still move and resize them in the video editor."
        )
      ),
      h(
        "div",
        { class: "fl-body" },
        imagesCol,
        h(
          "div",
          { class: "fl-side" },
          h(
            "div",
            { class: "fl-step" },
            h(
              "div",
              { class: "fl-step-head" },
              h("span", { class: "fl-num" }, "2"),
              h("span", { class: "fl-step-title" }, "Video"),
              h("div", { class: "spacer" }),
              h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  onclick: async () => {
                    const f = await host.browseVideo();
                    if (!f) return;
                    if (!videos.some(v => v.path === f)) {
                      const v = {
                        path: f,
                        name: f.split(/[\\/]/).pop()!,
                        current: false,
                      };
                      videos.unshift(v);
                      extra.unshift(v);
                    }
                    video = f;
                    drawVideos();
                    drawFoot();
                  },
                },
                icon(FolderOpen, 14),
                "Browse…"
              )
            ),
            searchBox(vq, "Search videos", v => {
              vq = v;
              drawVideos();
            }),
            videoList
          ),
          placeCol
        )
      ),
      h("div", { class: "fl-foot" }, summary, go)
    )
  );
  drawImages();
  drawVideos();
  drawPlace();
  drawFoot();
}

/** Pick library images in a dialog. Resolves with their files (empty when cancelled). */
export function pickFromLibrary(): Promise<{ path: string; name: string }[]> {
  return new Promise(resolve => {
    const picked = new Set<string>();
    let query = "";
    let result: { path: string; name: string }[] = [];
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
              disabled: !picked.size,
              onclick: () => {
                result = filtered({ q: "", category: null, sort: "new" })
                  .filter(i => picked.has(i.id))
                  .map(i => ({ path: pathOf(i.id), name: `${i.name}.png` }));
                close();
              },
            },
            picked.size > 1 ? `Add ${picked.size} images` : "Add"
          )
        )
      );
    };
    draw();
  });
}
