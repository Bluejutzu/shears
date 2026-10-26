import {
  Film,
  House,
  type IconNode,
  Image as ImageIcon,
  Keyboard,
  Plus,
  Settings as SettingsIcon,
  TriangleAlert,
} from "lucide";

import {
  enterImages,
  imageShortcuts,
  leaveImages,
  pickFromLibrary,
  type Placement,
} from "../images";
import { encoderLabel } from "../shared/api";
import { openSettings, store } from "../shared/settings";
import { basename, h, icon, menuOpen, modalOpen, toast } from "../shared/ui";
import { checkForUpdates } from "../shared/updates";
import { seek } from "./actions";
import { addAudioTrack, addImage } from "./editor";
import {
  closeSession,
  flushAll,
  openDialog,
  openFile,
  recents,
  renderHome,
} from "./home";
import { actions, keyLabel, showShortcuts } from "./keys";
import { renderMediaPool } from "./media";
import {
  appMode,
  appWindow,
  session,
  setAppMode,
  sidebarEl,
  theme,
  titleEl,
  tools,
} from "./state";
import { loadTimelineColors } from "./timeline";

// ---- little builders

export function appMark(size: number) {
  const el = h("span", { class: "app-mark" });
  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.6 14 17 5"/><path d="M13.4 14 7 5"/><circle cx="8.5" cy="17" r="2.7"/><circle cx="15.5" cy="17" r="2.7"/></svg>`;
  return el;
}

export function iconBtn(
  ic: IconNode,
  tip: string,
  key: string | null,
  run: () => void,
  cls = "icon-btn"
) {
  return h(
    "button",
    { class: cls, "data-tip": tip, "data-key": key, onclick: run },
    icon(ic, 16)
  ) as HTMLButtonElement;
}

export function toolBtn(
  ic: IconNode,
  label: string,
  tip: string,
  key: string,
  run: () => void
) {
  return h(
    "button",
    { class: "tool", "data-tip": tip, "data-key": key, onclick: run },
    icon(ic, 15),
    h("span", {}, label)
  ) as HTMLButtonElement;
}

export function toolsLabel() {
  if (!tools) return "Checking ffmpeg…";
  if (!tools.ffmpeg) return "ffmpeg not found";
  return `ffmpeg · ${encoderLabel(tools.encoder)}`;
}

export function toolsChip() {
  const missing = tools && !tools.ffmpeg;
  return h(
    "span",
    {
      class: `chip${missing ? " warn" : ""}`,
      "data-tip": missing
        ? "Exporting needs ffmpeg. Install it with: winget install Gyan.FFmpeg"
        : tools
          ? `Re-encodes use ${encoderLabel(tools.encoder)}`
          : "Looking for ffmpeg",
    },
    missing ? icon(TriangleAlert, 14) : null,
    toolsLabel()
  );
}

/** The window title: the app's own name on the home screen, "clip.mp4 — Shears" while editing. */
export function setTitle(text: string | null) {
  const app = store.app.name;
  titleEl.textContent = text ?? app;
  appWindow.setTitle(text ? ` — ` : app).catch(() => {});
}

// ---- sidebar: media pool

export function renderSidebar() {
  const scroll = sidebarEl.querySelector(".media-scroll")?.scrollTop ?? 0;
  sidebarEl.replaceChildren(
    h(
      "nav",
      { class: "nav" },
      h(
        "button",
        { class: "nav-item primary", onclick: openDialog },
        icon(Plus, 18),
        h("span", {}, "Open video")
      )
    ),
    renderMediaPool({
      current: session?.path ?? null,
      open: openFile,
      removeRecent: p => recents.remove(p),
      addAudio: session ? p => addAudioTrack(undefined, p) : undefined,
    }),
    sidebarFooter(() => closeSession())
  );
  const scroller = sidebarEl.querySelector(".media-scroll");
  if (scroller) scroller.scrollTop = scroll;
}

/** The app name, tools and settings at the bottom of both sidebars. */
export function sidebarFooter(home: () => void) {
  return h(
    "div",
    { class: "sb-footer" },
    h(
      "div",
      { class: "sb-footer-id" },
      h("div", { class: "avatar" }, appMark(15)),
      h(
        "div",
        { class: "sb-footer-text" },
        h("div", {}, store.app.name),
        h("div", { class: "dim" }, toolsLabel())
      )
    ),
    h(
      "div",
      { class: "sb-footer-actions" },
      iconBtn(House, "Home", null, home),
      iconBtn(Keyboard, "Keyboard shortcuts", "?", showShortcuts),
      iconBtn(SettingsIcon, "Settings", "Ctrl ,", showSettings)
    )
  );
}
export function showSettings() {
  openSettingsAt();
}

// ---- the two apps: the video editor and the image editor

export const modeSwitchEl = h("div", { class: "mode-switch", role: "tablist" });

export function renderModeSwitch() {
  const tab = (
    mode: "video" | "image",
    tip: string,
    key: string,
    ic: IconNode
  ) =>
    h(
      "button",
      {
        class: appMode === mode ? "active" : "",
        role: "tab",
        "aria-selected": String(appMode === mode),
        "aria-label": tip,
        "data-tip": tip,
        "data-key": key,
        "data-tip-pos": "below",
        onclick: () => setMode(mode),
      },
      icon(ic, 16)
    );
  modeSwitchEl.replaceChildren(
    tab("video", "Video editor", "Ctrl 1", Film),
    tab("image", "Image editor", "Ctrl 2", ImageIcon)
  );
}

export function setMode(mode: "video" | "image") {
  if (mode === appMode) return;
  setAppMode(mode);
  document.body.dataset.mode = mode;
  renderModeSwitch();
  if (mode === "image") {
    session?.video.pause();
    enterImages();
  } else {
    leaveImages();
    renderSidebar();
  }
}

/** Put library images on a video, each on its own image track. */
export async function sendImagesToVideo(
  images: { path: string; name: string }[],
  video: string,
  p: Placement
) {
  setMode("video");
  if (session?.path !== video) await openFile(video);
  const s = session;
  if (s?.path !== video) return;
  const first =
    p.start === "playhead"
      ? s.video.currentTime
      : p.start === "start"
        ? 0
        : p.start;
  let at = first;
  for (const img of images) {
    await addImage(at, img.path, { ...p, name: img.name });
    if (p.sequence) at += p.seconds;
  }
  seek(Math.min(first, s.probe.duration));
  toast(
    images.length === 1
      ? "Image added to the video"
      : `${images.length} images added to the video`,
    { body: basename(video) }
  );
}

/** Library images onto the open video at t, picked in a dialog. */
export async function addFromLibrary(t?: number) {
  const at = t ?? session?.video.currentTime;
  for (const img of (await pickFromLibrary()) ?? [])
    await addImage(at, img.path, { name: img.name.replace(/\.png$/, "") });
}

document.addEventListener("keydown", e => {
  if (modalOpen() || menuOpen()) return;
  if (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.altKey &&
    (e.key === "1" || e.key === "2")
  ) {
    e.preventDefault();
    setMode(e.key === "1" ? "video" : "image");
  }
});

export function openSettingsAt(
  section?: Parameters<typeof openSettings>[0]["section"]
) {
  openSettings({
    section,
    shortcuts: () => [
      ...actions.map(a => ({
        group: a.group,
        label: a.label,
        keys: a.keys.map(keyLabel),
      })),
      { group: "General", label: "Video editor", keys: ["Ctrl 1"] },
      { group: "General", label: "Image editor", keys: ["Ctrl 2"] },
      ...imageShortcuts(),
    ],
    onChange: () => {
      renderSidebar();
      if (!session) renderHome();
    },
    theme,
    restart: restartApp,
    colorsChanged: () => {
      loadTimelineColors();
      session?.tl.invalidate();
    },
    checkUpdates: () => checkForUpdates(),
  });
}

/** Reload the UI (used to switch themes), keeping settings, cuts and the open clip. */
export async function restartApp() {
  if (session)
    try {
      sessionStorage.setItem("reopen", session.path);
    } catch {}
  await flushAll();
  location.reload();
}
