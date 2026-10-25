import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, TriangleAlert } from "lucide";
import { api, encoderLabel, type Probe, type Tools } from "./api";
import type { Edit } from "./edit";
import { basename, dirname, ext, fmt, fmtSize, h, icon, join, modal, stem, toast } from "./ui";

type Settings = {
  copy: boolean;
  audio: "keep" | "mute" | "merge";
  height: number | null;
  targetMb: number | null;
  gpu: boolean;
};

const KEY = "export-settings";
const DEFAULTS: Settings = { copy: true, audio: "keep", height: null, targetMb: null, gpu: true };
const COPY_UNFRIENDLY = ["mkv", "flv", "ts", "avi", "wmv"];

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function segmented<T>(options: { label: string; value: T }[], value: T, pick: (v: T) => void) {
  return h(
    "div",
    { class: "segmented" },
    ...options.map((o) =>
      h("button", { class: o.value === value ? "active" : "", onclick: () => pick(o.value) }, o.label),
    ),
  );
}

function row(label: string, control: Node, hint?: string) {
  return h(
    "div",
    { class: "form-row" },
    h("div", { class: "form-label" }, label),
    h("div", { class: "form-control" }, control, hint ? h("div", { class: "form-hint" }, hint) : null),
  );
}

export async function openExport(opts: { path: string; probe: Probe; edit: Edit; tools: Tools | null }) {
  const { path, probe, edit, tools } = opts;
  if (!tools?.ffmpeg) {
    toast("ffmpeg not found", { body: "Install it with: winget install Gyan.FFmpeg, then restart Shears.", error: true });
    return;
  }
  const segments = edit.kept();
  if (!segments.length) {
    toast("Nothing to export", { body: "Every part of the clip is removed." });
    return;
  }

  const s = loadSettings();
  if (s.audio === "merge" && probe.audioTracks < 2) s.audio = "keep";
  if (s.height && s.height >= probe.height) s.height = null;
  const outDur = edit.outDuration();
  const encoder = tools.encoder;
  const hasGpu = encoder !== "libx264";

  const pickExt = () => {
    const e = ext(path);
    return s.copy && e && !COPY_UNFRIENDLY.includes(e) ? e : "mp4";
  };
  const defaultOutput = () => api.uniquePath(join(dirname(path), `${stem(path)}_cut.${pickExt()}`));
  let output = await defaultOutput();
  let customOutput = false;

  const body = h("div", { class: "export-body" });
  const { close } = modal("Export", body, {
    onClose: () => {
      if (running) api.cancel();
    },
  });
  let running = false;
  let phase: "form" | "running" | "done" | "error" = "form";

  const swapExt = async () => {
    if (customOutput) return;
    output = await defaultOutput();
  };

  const set = async (patch: Partial<Settings>) => {
    const modeChanged = patch.copy !== undefined && patch.copy !== s.copy;
    Object.assign(s, patch);
    if (modeChanged) await swapExt();
    render();
  };

  const estimate = () => {
    if (s.copy) return probe.size ? `~${fmtSize((probe.size * outDur) / probe.duration)}` : "";
    if (s.targetMb) return `≤ ${s.targetMb} MB`;
    return "";
  };

  function render() {
    const heights = [1080, 720, 480].filter((x) => x < probe.height);
    const audioOptions: { label: string; value: Settings["audio"] }[] = [
      { label: "Keep", value: "keep" },
      { label: "Mute", value: "mute" },
    ];
    if (probe.audioTracks > 1) audioOptions.push({ label: `Merge ${probe.audioTracks} tracks`, value: "merge" });

    const sizeInput = h("input", {
      class: "input input-sm",
      type: "number",
      min: "1",
      step: "1",
      placeholder: "Custom",
      value: s.targetMb && ![10, 25, 50].includes(s.targetMb) ? String(s.targetMb) : "",
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
              h("span", { class: "dim" }, output.slice(0, output.length - basename(output).length)),
              h("span", {}, basename(output)),
            ),
            h(
              "button",
              {
                class: "btn btn-secondary btn-sm",
                onclick: async () => {
                  const picked = await save({
                    defaultPath: output,
                    filters: [{ name: "Video", extensions: [ext(output) || "mp4"] }],
                  });
                  if (picked) {
                    output = picked;
                    customOutput = true;
                    render();
                  }
                },
              },
              "Change",
            ),
          ),
        ),
        row(
          "Mode",
          segmented(
            [
              { label: "Fast · lossless", value: true },
              { label: "Re-encode", value: false },
            ],
            s.copy,
            (copy) => set({ copy }),
          ),
          s.copy
            ? "Copies the original video, so it's near-instant. Cuts snap to the closest keyframe, which can be a little early."
            : "Frame-accurate cuts and size/resolution options. Takes a bit longer.",
        ),
        !s.copy &&
          row(
            "Resolution",
            segmented(
              [{ label: `Original · ${probe.height}p`, value: null as number | null }, ...heights.map((x) => ({ label: `${x}p`, value: x as number | null }))],
              s.height,
              (height) => set({ height }),
            ),
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
                s.targetMb && [10, 25, 50].includes(s.targetMb) ? s.targetMb : s.targetMb ? -1 : null,
                (targetMb) => set({ targetMb }),
              ),
              sizeInput,
            ),
            s.targetMb && hasGpu ? "Size limits always encode on the CPU (x264), since GPU encoders tend to overshoot." : undefined,
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
              (gpu) => set({ gpu }),
            ),
          ),
        probe.audioTracks > 0 &&
          row(
            "Audio",
            segmented(audioOptions, s.audio, (audio) => set({ audio })),
            s.audio === "merge" ? "Mixes every audio track (e.g. game + mic) into one." : undefined,
          ),
      ),
      h(
        "div",
        { class: "export-summary" },
        h("span", {}, `${fmt(outDur)} output`),
        h("span", { class: "dot" }, "·"),
        h("span", {}, `${segments.length} ${segments.length === 1 ? "part" : "parts"}`),
        estimate() && h("span", { class: "dot" }, "·"),
        estimate() && h("span", {}, estimate()),
      ),
      h(
        "div",
        { class: "modal-foot" },
        h("button", { class: "btn btn-ghost", onclick: () => close() }, "Cancel"),
        h("button", { class: "btn btn-primary", id: "export-go", onclick: run }, "Export", h("kbd", { class: "kbd-on-primary" }, "↵")),
      ),
    );
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !body.isConnected || e.target instanceof HTMLInputElement) return;
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
    localStorage.setItem(KEY, JSON.stringify(s));
    const started = performance.now();
    const pct = h("span", { class: "progress-pct" }, "0%");
    const bar = h("div", { class: "progress-fill" });
    const elapsed = h("span", { class: "dim" }, "0.0s");
    body.replaceChildren(
      h(
        "div",
        { class: "export-progress" },
        h("div", { class: "progress-head" }, h("span", {}, `Exporting ${basename(output)}`), pct),
        h("div", { class: "progress" }, bar),
        h("div", { class: "progress-meta" }, elapsed, h("span", { class: "dim" }, s.copy ? "Fast copy" : `Re-encoding · ${s.gpu && hasGpu && !s.targetMb ? encoderLabel(encoder) : "x264"}`)),
      ),
      h("div", { class: "modal-foot" }, h("button", { class: "btn btn-secondary", onclick: () => api.cancel() }, "Cancel")),
    );
    const tick = setInterval(() => (elapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`), 100);
    const unlisten = await listen<number>("job-progress", (e) => {
      const p = Math.round(e.payload * 100);
      pct.textContent = `${p}%`;
      bar.style.width = `${e.payload * 100}%`;
    });

    try {
      const size = await api.export({
        input: path,
        output,
        segments,
        copy: s.copy,
        encoder: s.gpu ? encoder : "libx264",
        audio: s.audio,
        audioTracks: probe.audioTracks,
        height: s.copy ? null : s.height,
        targetMb: s.copy ? null : s.targetMb,
      });
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      phase = "done";
      body.replaceChildren(
        h(
          "div",
          { class: "export-done" },
          h("div", { class: "done-icon" }, icon(Check, 22, 2.25)),
          h("div", { class: "done-title" }, `Exported in ${secs}s`),
          h("div", { class: "done-sub" }, `${basename(output)} · ${fmtSize(size)}`),
        ),
        h(
          "div",
          { class: "modal-foot" },
          h("button", { class: "btn btn-secondary", onclick: () => api.reveal(output) }, icon(FolderOpen, 15), "Show in folder"),
          h("button", { class: "btn btn-primary", onclick: () => close() }, "Done"),
        ),
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
          h("pre", { class: "error-log" }, msg),
        ),
        h(
          "div",
          { class: "modal-foot" },
          h("button", { class: "btn btn-ghost", onclick: () => close() }, "Close"),
          h(
            "button",
            {
              class: "btn btn-secondary",
              onclick: () => {
                phase = "form";
                render();
              },
            },
            "Back",
          ),
        ),
      );
    } finally {
      running = false;
      clearInterval(tick);
      unlisten();
    }
  }

  render();
}
