import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { FolderOpen, TriangleAlert } from "lucide";

import {
  api,
  encoderLabel,
  type AudioSource,
  type JobProgress,
  type Probe,
  type Tools,
} from "./api";
import type { Edit } from "./edit";
import { exportPath, saveSettings, store, type ExportPrefs } from "./settings";
import {
  basename,
  ext,
  fmt,
  fmtSize,
  h,
  icon,
  modal,
  progressBar,
  row,
  segmented,
  toast,
} from "./ui";

const COPY_UNFRIENDLY = ["mkv", "flv", "ts", "avi", "wmv"];

type Thumb = CanvasImageSource | undefined;

/** Where a moment in the exported video comes from in the source. */
function toSource(segments: [number, number][], t: number) {
  let acc = 0;
  for (const [a, b] of segments) {
    if (t <= acc + (b - a)) return a + (t - acc);
    acc += b - a;
  }
  return segments[segments.length - 1][1];
}

function drawFrame(canvas: HTMLCanvasElement, img: Thumb) {
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#1a1a19";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!img) return;
  const iw = (img as HTMLCanvasElement).width || canvas.width;
  const ih = (img as HTMLCanvasElement).height || canvas.height;
  const k = Math.max(canvas.width / iw, canvas.height / ih);
  ctx.drawImage(
    img,
    (canvas.width - iw * k) / 2,
    (canvas.height - ih * k) / 2,
    iw * k,
    ih * k
  );
}

/** Filmstrip of the output (kept parts back to back) that fills up as the export runs. */
function drawStrip(
  canvas: HTMLCanvasElement,
  segments: [number, number][],
  outDur: number,
  p: number,
  thumbAt: (t: number) => Thumb
) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 480;
  const hgt = 40;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, hgt, 8);
  ctx.clip();
  ctx.fillStyle = "#2a2927";
  ctx.fillRect(0, 0, w, hgt);
  const tw = hgt * (16 / 9);
  for (let x = 0; x < w; x += tw) {
    const img = thumbAt(toSource(segments, ((x + tw / 2) / w) * outDur));
    if (img) ctx.drawImage(img, x, 0, tw, hgt);
  }
  // little gaps where the cuts join up
  let acc = 0;
  ctx.fillStyle = "#1f1e1d";
  for (const [a, b] of segments.slice(0, -1)) {
    acc += b - a;
    ctx.fillRect((acc / outDur) * w - 1, 0, 2, hgt);
  }
  const px = Math.min(w, p * w);
  ctx.fillStyle = "rgba(26,26,25,0.68)";
  ctx.fillRect(px, 0, w - px, hgt);
  ctx.restore();
  ctx.fillStyle =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim() || "#4b9bff";
  ctx.fillRect(Math.max(0, px - 1), 0, 2, hgt);
}

export async function openExport(opts: {
  path: string;
  probe: Probe;
  edit: Edit;
  tools: Tools | null;
  thumbAt: (t: number) => Thumb;
}) {
  const { path, probe, edit, tools } = opts;
  if (!tools?.ffmpeg) {
    toast("ffmpeg not found", {
      body: "Install it with: winget install Gyan.FFmpeg, then restart Shears.",
      error: true,
    });
    return;
  }
  const segments = edit.kept();
  if (!segments.length) {
    toast("Nothing to export", { body: "Every part of the clip is removed." });
    return;
  }

  const s: ExportPrefs = { ...store.settings.export };
  if (s.height && s.height >= probe.height) s.height = null;
  // only images that show up in a kept part matter
  const overlays = edit.overlays
    .filter(o =>
      segments.some(([a, b]) => o.start < b && o.start + o.duration > a)
    )
    .map(o => ({
      path: o.path,
      start: o.start,
      end: o.start + o.duration,
      x: o.x,
      y: o.y,
      scale: o.scale,
      opacity: o.opacity,
    }));
  // fast copy can't draw images onto the video
  if (overlays.length) s.copy = false;
  const metaChanges = Object.keys(edit.meta.tags).length;
  const metaNote = edit.meta.strip
    ? "no metadata"
    : metaChanges
      ? `${metaChanges} metadata ${metaChanges === 1 ? "change" : "changes"}`
      : "";
  const outDur = edit.outDuration();
  const encoder = tools.encoder;
  const hasGpu = encoder !== "libx264";
  const active = edit.tracks.filter(t => !t.muted);
  const mutedCount = edit.tracks.length - active.length;
  if (s.audio === "separate" && active.length < 2) s.audio = "mix";
  const sources: AudioSource[] = active.map(t => ({
    path: t.kind === "file" ? t.path : null,
    track: t.index,
    offset: t.kind === "file" ? t.offset : 0,
    gainDb: t.gainDb,
  }));
  // fast copy can only skip re-encoding the audio when nothing about it changed
  const audioUntouched = () =>
    s.audio === "none" ||
    (s.audio === "separate" &&
      sources.every(x => x.path == null && Math.abs(x.gainDb) < 0.01)) ||
    (s.audio === "mix" &&
      sources.length === 1 &&
      sources[0].path == null &&
      Math.abs(sources[0].gainDb) < 0.01);

  const pickExt = () => {
    const e = ext(path);
    return s.copy && e && !COPY_UNFRIENDLY.includes(e) ? e : "mp4";
  };
  const defaultOutput = () => api.uniquePath(exportPath(path, pickExt()));
  let output = await defaultOutput();
  let customOutput = false;

  const body = h("div", { class: "export-body" });
  let running = false;
  let phase: "form" | "running" | "done" | "error" = "form";
  const { close } = modal("Export", body, {
    onClose: () => {
      if (running) api.cancel();
    },
  });

  const set = async (patch: Partial<ExportPrefs>) => {
    const modeChanged = patch.copy !== undefined && patch.copy !== s.copy;
    Object.assign(s, patch);
    if (modeChanged && !customOutput) output = await defaultOutput();
    render();
  };

  const estimate = () => {
    if (s.copy)
      return probe.size
        ? `~${fmtSize((probe.size * outDur) / probe.duration)}`
        : "";
    if (s.targetMb) return `≤ ${s.targetMb} MB`;
    return "";
  };

  function audioHint() {
    const bits: string[] = [];
    if (mutedCount)
      bits.push(
        `${mutedCount} muted ${mutedCount === 1 ? "track is" : "tracks are"} left out.`
      );
    if (s.audio === "mix" && active.length > 1)
      bits.push(
        `All ${active.length} tracks get mixed into one, with their volumes.`
      );
    if (s.audio === "separate")
      bits.push("Each track stays its own audio stream.");
    if (s.copy && !audioUntouched())
      bits.push(
        "The video is still copied as-is; only the audio gets re-encoded."
      );
    return bits.join(" ") || undefined;
  }

  function render() {
    const heights = [1080, 720, 480].filter(x => x < probe.height);
    const audioOptions: { label: string; value: ExportPrefs["audio"] }[] = [
      { label: active.length > 1 ? "Mix into one" : "Keep", value: "mix" },
    ];
    if (active.length > 1)
      audioOptions.push({ label: "Separate tracks", value: "separate" });
    audioOptions.push({ label: "No audio", value: "none" });

    const sizeInput = h("input", {
      class: "input input-sm",
      type: "number",
      min: "1",
      step: "1",
      placeholder: "Custom",
      value:
        s.targetMb && ![10, 25, 50].includes(s.targetMb)
          ? String(s.targetMb)
          : "",
      onchange: (e: Event) => {
        const v = parseFloat((e.target as HTMLInputElement).value);
        set({ targetMb: v > 0 ? v : null });
      },
    });

    body.replaceChildren(
      h(
        "div",
        { class: "form" },
        row(
          "Save to",
          h(
            "div",
            { class: "file-pick" },
            h(
              "div",
              { class: "file-pick-path", title: output },
              h(
                "span",
                { class: "dim" },
                output.slice(0, output.length - basename(output).length)
              ),
              h("span", {}, basename(output))
            ),
            h(
              "button",
              {
                class: "btn btn-secondary btn-sm",
                onclick: async () => {
                  const picked = await save({
                    defaultPath: output,
                    filters: [
                      { name: "Video", extensions: [ext(output) || "mp4"] },
                    ],
                  });
                  if (picked) {
                    output = picked;
                    customOutput = true;
                    render();
                  }
                },
              },
              "Change"
            )
          )
        ),
        row(
          "Mode",
          segmented(
            [
              ...(overlays.length
                ? []
                : [{ label: "Fast · lossless", value: true }]),
              { label: "Re-encode", value: false },
            ],
            s.copy,
            copy => set({ copy })
          ),
          overlays.length
            ? `${overlays.length === 1 ? "The image needs" : `${overlays.length} images need`} to be drawn onto the video, so this re-encodes (fast copy can't change pixels).`
            : s.copy
              ? "Copies the original video, so it's near-instant. Cuts move back to the closest keyframe, so they can start a little early."
              : "Frame-accurate cuts, rotation baked in, and size/resolution options. Takes a bit longer."
        ),
        !s.copy &&
          row(
            "Resolution",
            segmented(
              [
                {
                  label: `Original · ${probe.height}p`,
                  value: null as number | null,
                },
                ...heights.map(x => ({
                  label: `${x}p`,
                  value: x as number | null,
                })),
              ],
              s.height,
              height => set({ height })
            )
          ),
        !s.copy &&
          row(
            "Size limit",
            h(
              "div",
              { class: "inline" },
              segmented(
                [
                  { label: "None", value: null as number | null },
                  { label: "10 MB", value: 10 },
                  { label: "25 MB", value: 25 },
                  { label: "50 MB", value: 50 },
                ],
                s.targetMb && [10, 25, 50].includes(s.targetMb)
                  ? s.targetMb
                  : s.targetMb
                    ? -1
                    : null,
                targetMb => set({ targetMb })
              ),
              sizeInput
            ),
            s.targetMb && hasGpu
              ? "Size limits always encode on the CPU (x264), since GPU encoders tend to overshoot."
              : undefined
          ),
        !s.copy &&
          hasGpu &&
          !s.targetMb &&
          row(
            "Encoder",
            segmented(
              [
                { label: `GPU · ${encoderLabel(encoder)}`, value: true },
                { label: "CPU · x264", value: false },
              ],
              s.gpu,
              gpu => set({ gpu })
            )
          ),
        edit.tracks.length > 0 &&
          row(
            "Audio",
            segmented(audioOptions, s.audio, audio => set({ audio })),
            audioHint()
          )
      ),
      h(
        "div",
        { class: "export-summary" },
        h("span", {}, `${fmt(outDur)} output`),
        h("span", { class: "dot" }, "·"),
        h(
          "span",
          {},
          `${segments.length} ${segments.length === 1 ? "part" : "parts"}`
        ),
        estimate() && h("span", { class: "dot" }, "·"),
        estimate() && h("span", {}, estimate()),
        metaNote && h("span", { class: "dot" }, "·"),
        metaNote && h("span", {}, metaNote)
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
          { class: "btn btn-primary", onclick: run },
          "Export",
          h("kbd", { class: "kbd-on-primary" }, "↵")
        )
      )
    );
  }

  const onEnter = (e: KeyboardEvent) => {
    if (
      e.key !== "Enter" ||
      !body.isConnected ||
      e.target instanceof HTMLInputElement
    )
      return;
    e.preventDefault();
    if (phase === "form") run();
    else if (phase === "done") close();
  };
  document.addEventListener("keydown", onEnter);
  const observer = new MutationObserver(() => {
    if (!body.isConnected) {
      document.removeEventListener("keydown", onEnter);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  async function run() {
    if (running) return;
    running = true;
    phase = "running";
    // don't let a forced re-encode (for images) change the remembered mode
    store.settings.export = {
      ...s,
      copy: overlays.length ? store.settings.export.copy : s.copy,
    };
    saveSettings();
    const started = performance.now();
    const fps = probe.fps > 0 ? probe.fps : 30;
    const totalFrames = Math.max(1, Math.round(outDur * fps));
    const pct = h("span", { class: "progress-pct" }, "0%");
    const elapsed = h("span", { class: "dim" }, "0.0s");
    const frame = h("canvas", {
      class: "export-frame",
      width: "320",
      height: "180",
    }) as HTMLCanvasElement;
    const frameTime = h(
      "span",
      { class: "export-frame-time" },
      `0:00 / ${fmt(outDur, false)}`
    );
    const strip = h("canvas", { class: "export-strip" }) as HTMLCanvasElement;
    // Material 3's wavy bar; in Shears the filmstrip filling up shows progress instead
    const wavy = progressBar({ flat: false });
    const stat = (label: string) => {
      const value = h("span", { class: "stat-value" }, "–");
      const sub = h("span", { class: "stat-sub" });
      return {
        el: h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, label),
          value,
          sub
        ),
        value,
        sub,
      };
    };
    const stats = {
      fps: stat("Rendering"),
      speed: stat("Speed"),
      frames: stat("Frames"),
      left: stat("Time left"),
    };

    body.replaceChildren(
      h(
        "div",
        { class: "export-progress" },
        h(
          "div",
          { class: "progress-head" },
          h("span", {}, `Exporting ${basename(output)}`),
          pct
        ),
        wavy.el,
        h(
          "div",
          { class: "export-live" },
          h("div", { class: "export-frame-wrap" }, frame, frameTime),
          h(
            "div",
            { class: "export-stats" },
            stats.fps.el,
            stats.speed.el,
            stats.frames.el,
            stats.left.el
          )
        ),
        strip,
        h(
          "div",
          { class: "progress-meta" },
          elapsed,
          h(
            "span",
            { class: "dim" },
            s.copy
              ? "Fast copy"
              : `Re-encoding · ${s.gpu && hasGpu && !s.targetMb ? encoderLabel(encoder) : "x264"}`
          )
        )
      ),
      h(
        "div",
        { class: "modal-foot" },
        h(
          "button",
          { class: "btn btn-secondary", onclick: () => api.cancel() },
          "Cancel"
        )
      )
    );

    let progress = 0;
    drawStrip(strip, segments, outDur, progress, opts.thumbAt);
    drawFrame(frame, opts.thumbAt(segments[0][0]));
    const tick = setInterval(
      () =>
        (elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`),
      100
    );
    const unlisten = await listen<JobProgress>("job-progress", e => {
      const { p, fps: renderFps, speed } = e.payload;
      progress = p;
      pct.textContent = `${Math.round(p * 100)}%`;
      wavy.set(p);
      const done = Math.min(totalFrames, Math.round(p * totalFrames));
      stats.fps.value.textContent =
        renderFps > 0 ? `${Math.round(renderFps)} fps` : "–";
      stats.speed.value.textContent = speed > 0 ? `${speed.toFixed(1)}×` : "–";
      stats.speed.sub.textContent = speed > 0 ? "of realtime" : "";
      stats.frames.value.textContent = `${done.toLocaleString()} / ${totalFrames.toLocaleString()}`;
      stats.frames.sub.textContent = `${(totalFrames - done).toLocaleString()} left`;
      const secs = (performance.now() - started) / 1000;
      stats.left.value.textContent =
        p > 0.02 ? `~${Math.max(0, Math.round((secs * (1 - p)) / p))}s` : "–";
      const outTime = p * outDur;
      frameTime.textContent = `${fmt(outTime, false)} / ${fmt(outDur, false)}`;
      drawFrame(frame, opts.thumbAt(toSource(segments, outTime)));
      drawStrip(strip, segments, outDur, progress, opts.thumbAt);
    });

    try {
      const size = await api.export({
        input: path,
        output,
        segments,
        copy: s.copy,
        encoder: s.gpu ? encoder : "libx264",
        audio: s.audio,
        sources,
        height: s.copy ? null : s.height,
        targetMb: s.copy ? null : s.targetMb,
        rotate: edit.look.rotate,
        flip: edit.look.flip,
        sourceRotation: probe.rotation ?? 0,
        overlays: s.copy ? [] : overlays,
        metadata: edit.metaEdit(),
      });
      const secs = (performance.now() - started) / 1000;
      phase = "done";
      const hero = h("canvas", {
        class: "done-thumb",
        width: "480",
        height: "270",
      }) as HTMLCanvasElement;
      drawFrame(
        hero,
        opts.thumbAt(toSource(segments, Math.min(outDur * 0.1, 3)))
      );
      const badge = h("div", { class: "done-badge" });
      badge.innerHTML = `<svg viewBox="0 0 52 52" width="30" height="30"><path class="check-mark" d="M14 27l8 8 16-17" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      body.replaceChildren(
        h(
          "div",
          { class: "export-done" },
          h("div", { class: "done-hero" }, hero, badge),
          h("div", { class: "done-title" }, `Exported in ${secs.toFixed(1)}s`),
          h(
            "div",
            { class: "done-sub" },
            `${basename(output)} · ${fmtSize(size)} · ${fmt(outDur, false)}`
          ),
          h(
            "div",
            { class: "done-sub dim" },
            `${Math.max(1, outDur / Math.max(secs, 0.01)).toFixed(1)}× faster than realtime`
          )
        ),
        h(
          "div",
          { class: "modal-foot" },
          h(
            "button",
            { class: "btn btn-secondary", onclick: () => api.reveal(output) },
            icon(FolderOpen, 15),
            "Show in folder"
          ),
          h(
            "button",
            { class: "btn btn-primary", onclick: () => close() },
            "Done"
          )
        )
      );
    } catch (err) {
      const msg = String(err);
      if (msg === "Cancelled") {
        if (body.isConnected) close();
        return;
      }
      phase = "error";
      body.replaceChildren(
        h(
          "div",
          { class: "export-done" },
          h("div", { class: "done-icon error" }, icon(TriangleAlert, 22, 2)),
          h("div", { class: "done-title" }, "Export failed"),
          h("pre", { class: "error-log" }, msg)
        ),
        h(
          "div",
          { class: "modal-foot" },
          h(
            "button",
            { class: "btn btn-ghost", onclick: () => close() },
            "Close"
          ),
          h(
            "button",
            {
              class: "btn btn-secondary",
              onclick: () => {
                phase = "form";
                render();
              },
            },
            "Back"
          )
        )
      );
    } finally {
      running = false;
      clearInterval(tick);
      unlisten();
    }
  }

  render();
}
