import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type AudioStream = {
  codec: string;
  channels: number;
  title: string | null;
};

export type Probe = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string | null;
  audioTracks: number;
  audio: AudioStream[];
  rotation: number;
  size: number;
  container: string;
};

export type Tools = { ffmpeg: string | null; encoder: string };

export type AudioSource = {
  path: string | null;
  track: number;
  offset: number;
  gainDb: number;
};

export type ExportJob = {
  input: string;
  output: string;
  segments: [number, number][];
  copy: boolean;
  encoder: string;
  audio: "mix" | "separate" | "none";
  sources: AudioSource[];
  height: number | null;
  targetMb: number | null;
  rotate: number;
  flip: boolean;
  sourceRotation: number;
  overlays: {
    path: string;
    start: number;
    end: number;
    x: number;
    y: number;
    scale: number;
    opacity: number;
  }[];
  metadata: MetaEdit;
};

/** Tag changes on top of a file's own: a string sets a tag, null removes it. */
export type MetaEdit = { strip: boolean; tags: [string, string | null][] };

/** Payload of the "job-progress" event. */
export type JobProgress = { p: number; fps: number; speed: number };

export type MediaFile = {
  path: string;
  name: string;
  size: number;
  modified: number;
};

export type Paths = {
  settings: string;
  data: string;
  cache: string;
  defaultCache: string;
};

export const api = {
  tools: () => invoke<Tools>("tools"),
  probe: (path: string) => invoke<Probe>("probe", { path }),
  probeAudio: (path: string) => invoke<Probe>("probe_audio", { path }),
  waveform: async (path: string, track: number) =>
    new Uint8Array(await invoke<ArrayBuffer>("waveform", { path, track })),
  extractAudio: (path: string, track: number, codec: string) =>
    invoke<string>("extract_audio", { path, track, codec }),
  thumbnail: (path: string, at: number) =>
    invoke<string>("thumbnail", { path, at }),
  listMedia: (dir: string) => invoke<MediaFile[]>("list_media", { dir }),
  mediaInfo: (path: string) =>
    invoke<{ duration: number; thumb: string | null }>("media_info", { path }),
  saveFrame: (
    input: string,
    time: number,
    output: string,
    rotate: number,
    flip: boolean
  ) => invoke<void>("save_frame", { input, time, output, rotate, flip }),
  makePreview: (input: string, duration: number, transcode: boolean) =>
    invoke<string>("make_preview", { input, duration, transcode }),
  export: (job: ExportJob) => invoke<number>("export", { job }),
  cancel: () => invoke<void>("cancel"),
  initialFile: () => invoke<string | null>("initial_file"),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  uniquePath: (path: string) => invoke<string>("unique_path", { path }),
  loadState: () =>
    invoke<{
      settings: Record<string, unknown>;
      recents: unknown;
      paths: Paths;
    }>("load_state"),
  saveSettings: (settings: unknown) =>
    invoke<string>("save_settings", { settings }),
  saveRecents: (recents: unknown) => invoke<void>("save_recents", { recents }),
  loadEdit: (path: string) => invoke<unknown | null>("load_edit", { path }),
  saveEdit: (path: string, edit: unknown | null) =>
    invoke<void>("save_edit", { path, edit }),
  forgetEdits: () => invoke<void>("forget_edits"),
  readTags: (path: string) =>
    invoke<Record<string, string>>("read_tags", { path }),
  writeMetadata: (input: string, output: string | null, edit: MetaEdit) =>
    invoke<void>("write_metadata", { input, output, edit }),
  cacheSize: () => invoke<number>("cache_size"),
  clearCache: () => invoke<void>("clear_cache"),
};

export const fileUrl = (path: string) => convertFileSrc(path);

export const encoderLabel = (enc: string) =>
  ({ h264_nvenc: "NVENC", h264_qsv: "Quick Sync", h264_amf: "AMF" })[enc] ??
  "x264";
