import { getCurrentWebview } from "@tauri-apps/api/webview";

import "../style.css";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Clapperboard,
  Copy,
  Film,
  FolderOpen,
  Minus,
  PanelLeft,
  Square,
  X,
} from "lucide";

import { imageDrop, initImages } from "../images";
import { api } from "../shared/api";
import { loadState, store } from "../shared/settings";
import { loadTheme } from "../shared/themes";
import {
  basename,
  debug,
  ext,
  h,
  icon,
  initTooltips,
  toast,
} from "../shared/ui";
import { autoCheck, setBeforeInstall } from "../shared/updates";
import { toggleSidebar } from "./actions";
import {
  modeSwitchEl,
  renderModeSwitch,
  renderSidebar,
  sendImagesToVideo,
  showSettings,
  sidebarFooter,
} from "./chrome";
import { addAudioTrack, addImage, loadTrackMedia } from "./editor";
import { flushAll, openFile, renderHome } from "./home";
import { showShortcuts } from "./keys";
import { addMediaFolder, poolVideos, startMediaWatch } from "./media";
import { IMAGE_EXTS } from "./overlays";
import { loop } from "./panels";
import {
  $,
  appMode,
  appWindow,
  AUDIO_EXTS,
  opening,
  session,
  setTheme,
  setTools,
  VIDEO_EXTS,
} from "./state";

// ---- window chrome + boot

function setupChrome() {
  $("btn-sidebar").append(icon(PanelLeft, 18));
  $("btn-sidebar").addEventListener("click", toggleSidebar);
  document.documentElement.classList.toggle(
    "sb-collapsed",
    store.settings.ui.sidebarCollapsed
  );

  const min = $("win-min");
  const max = $("win-max");
  const close = $("win-close");
  min.append(icon(Minus, 16, 1.5));
  max.append(icon(Square, 13, 1.5));
  close.append(icon(X, 17, 1.5));
  min.addEventListener("click", () => appWindow.minimize());
  max.addEventListener("click", () => appWindow.toggleMaximize());
  close.addEventListener("click", () => appWindow.close());
  // however the window gets closed (our button, the taskbar, Alt+F4), save first
  appWindow.onCloseRequested(() => flushAll());
  if (store.app.channel === "dev")
    $("btn-sidebar").after(
      h(
        "span",
        {
          class: "dev-badge",
          "data-tip": "Local build: its own settings, no automatic updates",
          "data-tip-pos": "below",
        },
        "DEV"
      )
    );
  $("btn-sidebar").parentElement!.append(modeSwitchEl);
  renderModeSwitch();
  appWindow.onResized(async () => {
    const maximized = await appWindow.isMaximized();
    max.replaceChildren(
      maximized ? icon(Copy, 13, 1.5) : icon(Square, 13, 1.5)
    );
  });

  // keep focus off buttons so Space/arrows always go to the editor
  document.addEventListener("mousedown", e => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  if (!import.meta.env.DEV)
    document.addEventListener("contextmenu", e => e.preventDefault());

  const dropText = h("div", { class: "drop-text" }, "Drop a video to open it");
  document.body.append(
    h(
      "div",
      { class: "drop-overlay" },
      h(
        "div",
        { class: "drop-inner" },
        h(
          "div",
          { class: "drop-icons" },
          icon(Film, 30, 1.5),
          icon(Clapperboard, 30, 1.5),
          icon(FolderOpen, 30, 1.5)
        ),
        dropText
      )
    )
  );
  getCurrentWebview().onDragDropEvent(e => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") {
      document.body.classList.add("dragging");
      dropText.textContent =
        appMode === "image"
          ? "Drop pictures to add them"
          : session
            ? "Drop a video to open it, or an image or audio file to add it"
            : "Drop a video to open it";
    } else if (p.type === "leave") document.body.classList.remove("dragging");
    else if (p.type === "drop") {
      document.body.classList.remove("dragging");
      if (appMode === "image") {
        imageDrop(p.paths);
        return;
      }
      // while editing, images and audio files get added to the clip at the playhead
      if (session) {
        const images = p.paths.filter(x => IMAGE_EXTS.includes(ext(x)));
        const sounds = p.paths.filter(
          x => AUDIO_EXTS.includes(ext(x)) && !VIDEO_EXTS.includes(ext(x))
        );
        if (images.length || sounds.length) {
          (async () => {
            for (const f of images) await addImage(undefined, f);
            for (const f of sounds) await addAudioTrack(undefined, f);
          })();
          return;
        }
      }
      const file = p.paths.find(x => VIDEO_EXTS.includes(ext(x)));
      if (file) openFile(file);
      else if (p.paths.length) {
        // a dropped folder becomes a media pool folder
        api
          .listMedia(p.paths[0])
          .then(() => addMediaFolder(p.paths[0]))
          .catch(() =>
            toast("That doesn't look like a video", {
              body: basename(p.paths[0]),
            })
          );
      }
    }
  });
}

async function boot() {
  initTooltips();
  const [, app] = await Promise.all([
    loadState(),
    api.appInfo().catch(() => null),
  ]);
  if (app) store.app = app;
  debug.menuTriangle =
    store.app.channel === "dev" && store.settings.debug.menuTriangle;
  setTheme(await loadTheme(store.settings.theme, store.settings.m3));
  setupChrome();
  setBeforeInstall(flushAll);
  autoCheck();
  renderSidebar();
  renderHome();
  requestAnimationFrame(loop);
  startMediaWatch(renderSidebar);
  document.body.dataset.mode = "video";
  initImages({
    footer: () => sidebarFooter(() => {}),
    showSettings,
    showShortcuts,
    browseVideo: async () => {
      const f = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Video", extensions: VIDEO_EXTS }],
      });
      return typeof f === "string" ? f : null;
    },
    videos: () => {
      const seen = new Set<string>();
      const out: {
        path: string;
        name: string;
        current: boolean;
        thumb?: string;
      }[] = [];
      const add = (path: string, current = false) => {
        if (seen.has(path)) return;
        seen.add(path);
        const thumb = store.recents.find(r => r.path === path)?.thumb;
        out.push({ path, name: basename(path), current, thumb });
      };
      if (session) add(session.path, true);
      for (const r of store.recents) add(r.path);
      for (const f of poolVideos()) add(f.path);
      return out;
    },
    send: sendImagesToVideo,
  });

  api.tools().then(t => {
    setTools(t);
    renderSidebar();
    if (!session && !opening) renderHome();
    if (session)
      for (const tr of session.edit.tracks) loadTrackMedia(session, tr);
  });
  let reopen: string | null = null;
  try {
    reopen = sessionStorage.getItem("reopen");
    sessionStorage.removeItem("reopen");
  } catch {}
  if (reopen) openFile(reopen);
  else
    api.initialFile().then(p => {
      if (p) openFile(p);
    });
}

boot();
