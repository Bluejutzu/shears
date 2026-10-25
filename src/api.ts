import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type Probe = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string | null;
  audioTracks: number;
  size: number;
  container: string;
};

export type Tools = { ffmpeg: string | null; encoder: string };

export type ExportJob = {
  input: string;
  output: string;
  segments: [number, number][];
  copy: boolean;
  encoder: string;
  audio: "keep" | "mute" | "merge";
  audioTracks: number;
  height: number | null;
  targetMb: number | null;
};

export const api = {
  tools: () => invoke<Tools>("tools"),
  probe: (path: string) => invoke<Probe>("probe", { path }),
  waveform: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("waveform", { path })),
  thumbnail: (path: string, at: number) => invoke<string>("thumbnail", { path, at }),
  saveFrame: (input: string, time: number, output: string) => invoke<void>("save_frame", { input, time, output }),
  makePreview: (input: string, duration: number, transcode: boolean) =>
    invoke<string>("make_preview", { input, duration, transcode }),
  export: (job: ExportJob) => invoke<number>("export", { job }),
  cancel: () => invoke<void>("cancel"),
  initialFile: () => invoke<string | null>("initial_file"),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  uniquePath: (path: string) => invoke<string>("unique_path", { path }),
};

export const fileUrl = (path: string) => convertFileSrc(path);

export const encoderLabel = (enc: string) =>
  ({ h264_nvenc: "NVENC", h264_qsv: "Quick Sync", h264_amf: "AMF" })[enc] ?? "x264";
