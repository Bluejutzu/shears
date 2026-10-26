import { getCurrentWindow } from "@tauri-apps/api/window";
import { type IconNode } from "lucide";

import { type Probe, type Tools } from "../shared/api";
import { type Theme } from "../shared/themes";
import { AudioEngine } from "./audio";
import { Edit } from "./edit";
import { OverlayLayer } from "./overlays";
import { Timeline } from "./timeline";

export const VIDEO_EXTS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "m4v",
  "avi",
  "flv",
  "ts",
  "wmv",
  "mts",
  "m2ts",
  "3gp",
];
export const AUDIO_EXTS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "flac",
  "wma",
  ...VIDEO_EXTS,
];
export const RATES = [0.25, 0.5, 1, 1.5, 2, 4];

export const MarkIn: IconNode = [
  ["path", { d: "M10 4H6v16h4" }],
  ["path", { d: "M14 12h5" }],
];
export const MarkOut: IconNode = [
  ["path", { d: "M14 4h4v16h-4" }],
  ["path", { d: "M5 12h5" }],
];

export const appWindow = getCurrentWindow();
export const $ = (id: string) => document.getElementById(id)!;
export const mainEl = $("main");
export const sidebarEl = $("sidebar");
export const titleEl = $("title");
export const tbActions = $("tb-actions");
export const clamp = (v: number, a: number, b: number) =>
  Math.min(Math.max(v, a), b);

export let tools: Tools | null = null;
export let theme: Theme = { name: "shears", banner: () => {}, apply: () => {} };

export type Session = {
  path: string;
  probe: Probe;
  fps: number;
  edit: Edit;
  video: HTMLVideoElement;
  tl: Timeline;
  layer: OverlayLayer;
  engine: AudioEngine;
  peaks: Map<string, Uint8Array>;
  loading: Set<string>;
  muted: boolean;
  alive: boolean;
  previewStage: number;
  thumbsStarted: boolean;
  els: {
    stage: HTMLElement;
    cur: HTMLElement;
    play: HTMLElement;
    speed: HTMLElement;
    vol: HTMLElement;
    volRange: HTMLInputElement;
    volLabel: HTMLElement;
    out: HTMLElement;
    badge: HTMLElement;
    stageMsg: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    keep: HTMLButtonElement;
    props: HTMLElement;
  };
};

export let session: Session | null = null;
export let appMode: "video" | "image" = "video";
export let openToken = 0;
export let opening = false;

// modules can read these directly, but only this one can reassign them
export const setSession = (s: Session | null) => (session = s);
export const setTools = (t: Tools | null) => (tools = t);
export const setTheme = (t: Theme) => (theme = t);
export const setAppMode = (m: "video" | "image") => (appMode = m);
export const setOpening = (v: boolean) => (opening = v);
export const nextOpenToken = () => ++openToken;
