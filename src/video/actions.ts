import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../shared/api";
import { framePath, saveSettings, store } from "../shared/settings";
import { basename, fmt, menu, stem, toast } from "../shared/ui";
import { type Overlay, type Track } from "./edit";
import { openExport } from "./exporter";
import { ms } from "./menus";
import { IMAGE_EXTS } from "./overlays";
import { updateVolumeUI } from "./panels";
import { clamp, RATES, session, Session, tools } from "./state";

// ---- actions

export function time() {
  return session?.video.currentTime ?? 0;
}

export function seek(t: number) {
  const s = session;
  if (!s) return;
  s.video.currentTime = clamp(t, 0, s.probe.duration);
  s.tl.invalidate();
}

export function togglePlay() {
  const s = session;
  if (!s) return;
  const v = s.video;
  if (!v.paused) {
    v.pause();
    return;
  }
  const kept = s.edit.kept();
  if (!kept.length) return;
  const t = v.currentTime;
  if (t >= kept[kept.length - 1][1] - 0.05) v.currentTime = kept[0][0];
  else if (!s.edit.isKept(t)) v.currentTime = s.edit.nextKept(t) ?? kept[0][0];
  s.engine.resume();
  v.play().catch(() => {});
}

export function stepFrame(n: number) {
  const s = session;
  if (!s) return;
  s.video.pause();
  seek(time() + n / s.fps);
}

export function seekBy(d: number) {
  seek(time() + d);
}

export function cutPoints(s: Session) {
  const pts = [
    0,
    ...s.edit.cuts(),
    s.edit.inPt,
    s.edit.outPt,
    s.probe.duration,
  ];
  return pts.filter((p): p is number => p != null).sort((a, b) => a - b);
}

export function prevCut() {
  if (!session) return;
  const t = time();
  const pts = cutPoints(session).filter(p => p < t - 0.01);
  seek(pts.length ? pts[pts.length - 1] : 0);
}

export function nextCut() {
  if (!session) return;
  const t = time();
  seek(cutPoints(session).find(p => p > t + 0.01) ?? session.probe.duration);
}

export function split() {
  session?.edit.split(time());
}

export function del() {
  const e = session?.edit;
  if (!e) return;
  // a selected image or added audio file (without the video) gets deleted like a clip
  if (!e.isSelected("video") && removableIds().length) {
    deleteSelection();
    return;
  }
  const r = e.range();
  if (r && e.sel < 0) e.setRange(r[0], r[1], false);
  else e.toggle(e.sel >= 0 ? e.sel : e.indexAt(time()));
}

// declared as functions, not arrows: the keyboard list in keys.ts takes them while loading
export function trimBefore() {
  session?.edit.trimBefore(time());
}
export function trimAfter() {
  session?.edit.trimAfter(time());
}
export function markIn() {
  session?.edit.setMark("in", time());
}
export function markOut() {
  session?.edit.setMark("out", time());
}

export function keepRange() {
  const e = session?.edit;
  if (!e) return;
  const r = e.range();
  if (!r)
    toast("No range marked", {
      body: "Press I and O to mark the part you want to keep.",
    });
  else e.keepOnly(r[0], r[1]);
}

// ---- clipboard: images and audio tracks can be cut, copied, pasted and duplicated

export let clipboard: {
  overlays: Overlay[];
  tracks: Track[];
  anchor: number;
} | null = null;

export const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * What cut/copy/duplicate/delete act on: the given ids (a right-clicked track or image),
 * otherwise the selection. From the selection, the video's own tracks only count when
 * picked on their own, not as part of the linked video.
 */
export function selectedItems(ids?: string[]) {
  const e = session?.edit;
  if (!e) return { overlays: [], tracks: [] };
  const pick = (id: string) => (ids ? ids.includes(id) : e.isSelected(id));
  return {
    overlays: e.overlays.filter(o => pick(o.id)),
    tracks: e.tracks.filter(
      t => pick(t.id) && (!!ids || t.kind === "file" || !e.isSelected("video"))
    ),
  };
}

/** The ones that can be deleted outright (the video's own tracks can't). */
export function removableIds(ids?: string[]) {
  const { overlays, tracks } = selectedItems(ids);
  return [...overlays, ...tracks.filter(t => t.kind === "file")].map(x => x.id);
}

export const startOf = (x: Overlay | Track) =>
  "start" in x ? x.start : x.kind === "file" ? x.offset : 0;

export function copySelection(cut = false, ids?: string[]) {
  const s = session;
  if (!s) return;
  const { overlays, tracks } = selectedItems(ids);
  if (!overlays.length && !tracks.length) {
    // nothing to copy, so copy where the playhead is instead
    copyTimecode(s.video.currentTime);
    return;
  }
  clipboard = {
    overlays: overlays.map(o => ({ ...o })),
    tracks: tracks.map(t => ({ ...t })),
    anchor: Math.min(...[...overlays, ...tracks].map(startOf)),
  };
  if (cut) s.edit.removeItems(removableIds(ids));
}

/** Copies of overlays starting at `start`, kept inside the clip. */
export function placeOverlay(o: Overlay, start: number, dur: number): Overlay {
  const at = ms(clamp(start, 0, dur - 0.1));
  return {
    ...o,
    id: newId("o"),
    start: at,
    duration: ms(Math.min(o.duration, dur - at)),
  };
}

/** A track of the video itself comes back as its own track, playing the same audio. */
export const copyTrack = (t: Track, offset: number): Track => ({
  ...t,
  id: newId("f"),
  kind: "file",
  offset: ms(offset),
  linked: false,
  solo: false,
});

/** Paste so the earliest copied item starts at `at` (the playhead by default). */
export function paste(at?: number) {
  const s = session;
  if (!s || !clipboard) return;
  const shift = (at ?? s.video.currentTime) - clipboard.anchor;
  const dur = s.probe.duration;
  s.edit.addItems(
    clipboard.overlays.map(o => placeOverlay(o, o.start + shift, dur)),
    clipboard.tracks.map(t => copyTrack(t, startOf(t) + shift))
  );
}

/** Copies right next to the originals: images after themselves, tracks on a new lane. */
export function duplicate(ids?: string[]) {
  const s = session;
  if (!s) return;
  const { overlays, tracks } = selectedItems(ids);
  if (!overlays.length && !tracks.length) return;
  const dur = s.probe.duration;
  s.edit.addItems(
    overlays.map(o => placeOverlay(o, o.start + o.duration, dur)),
    tracks.map(t => copyTrack(t, startOf(t)))
  );
}

export function deleteSelection(ids?: string[]) {
  const del = removableIds(ids);
  if (del.length) session?.edit.removeItems(del);
}

export function copyTimecode(t: number) {
  const tc = fmt(t);
  navigator.clipboard?.writeText(tc).catch(() => {});
  toast(`Copied timecode ${tc}`);
}

export async function replaceImage(o: Overlay) {
  const s = session;
  const picked = await open({
    multiple: false,
    directory: false,
    defaultPath: o.path,
    filters: [{ name: "Images", extensions: IMAGE_EXTS }],
  });
  if (typeof picked !== "string" || session !== s) return;
  s?.edit.updateOverlay(o.id, { path: picked, name: stem(picked) });
}

export function selectAll() {
  const e = session?.edit;
  if (!e) return;
  e.selected = [
    "video",
    ...e.tracks.map(t => t.id),
    ...e.overlays.map(o => o.id),
  ];
  e.onChange();
}

export function deselect() {
  if (!session) return;
  session.edit.sel = -1;
  session.tl.invalidate();
}

export function setRate(rate: number) {
  if (session) session.video.playbackRate = rate;
}

export function shiftRate(dir: 1 | -1) {
  if (!session) return;
  const i = RATES.indexOf(session.video.playbackRate);
  setRate(RATES[clamp((i < 0 ? 2 : i) + dir, 0, RATES.length - 1)]);
}

export function speedMenu(anchor: HTMLElement) {
  const current = session?.video.playbackRate ?? 1;
  menu(
    anchor,
    [
      { section: "Playback speed" },
      ...RATES.map((r, i) => ({
        label: `${r}×`,
        hint: String(i + 1),
        checked: r === current,
        run: () => setRate(r),
      })),
    ],
    { align: "end" }
  );
}

export function toggleMute() {
  const s = session;
  if (!s) return;
  s.muted = !s.muted;
  s.engine.setMaster(store.settings.volumeDb, s.muted);
  s.engine.applyGains(s.edit.tracks);
  updateVolumeUI(s);
}

export async function saveFrame() {
  const s = session;
  if (!s) return;
  if (!tools?.ffmpeg) {
    toast("ffmpeg not found", {
      body: "Saving frames needs ffmpeg. Install it with: winget install Gyan.FFmpeg",
      error: true,
    });
    return;
  }
  const t = s.video.currentTime;
  const out = await api.uniquePath(
    framePath(s.path, fmt(t).replace(/[:.]/g, "-"))
  );
  try {
    await api.saveFrame(s.path, t, out, s.edit.look.rotate, s.edit.look.flip);
    toast("Frame saved", {
      body: basename(out),
      action: { label: "Show in folder", run: () => api.reveal(out) },
    });
  } catch (err) {
    toast("Couldn't save frame", { body: String(err), error: true });
  }
}

export function doExport() {
  const s = session;
  if (!s) return;
  s.video.pause();
  openExport({
    path: s.path,
    probe: s.probe,
    edit: s.edit,
    tools,
    thumbAt: t => s.tl.thumbAt(t),
  });
}

export function toggleSidebar() {
  const ui = store.settings.ui;
  ui.sidebarCollapsed = !ui.sidebarCollapsed;
  document.documentElement.classList.toggle(
    "sb-collapsed",
    ui.sidebarCollapsed
  );
  saveSettings();
}
