import { open } from "@tauri-apps/plugin-dialog";
import { Film, FolderOpen, Upload } from "lucide";

import { api, fileUrl, type Probe } from "../shared/api";
import {
  flushSettings,
  type Recent,
  setRecents,
  store,
} from "../shared/settings";
import { ago, basename, ext, fmt, h, icon, toast } from "../shared/ui";
import { renderSidebar, setTitle, toolsChip } from "./chrome";
import { type Doc } from "./edit";
import { buildEditor } from "./editor";
import {
  mainEl,
  nextOpenToken,
  opening,
  openToken,
  session,
  Session,
  setOpening,
  setSession,
  tbActions,
  theme,
  tools,
  VIDEO_EXTS,
} from "./state";

// ---- recents

export const recents = {
  list: () => store.recents,
  save(list: Recent[]) {
    setRecents(list);
    renderSidebar();
    if (!session && !opening) renderHome();
  },
  add(r: Recent) {
    recents.save([r, ...store.recents.filter(x => x.path !== r.path)]);
  },
  update(path: string, patch: Partial<Recent>) {
    recents.save(
      store.recents.map(r => (r.path === path ? { ...r, ...patch } : r))
    );
  },
  remove(path: string) {
    recents.save(store.recents.filter(r => r.path !== path));
  },
};

// ---- home

export function renderHome() {
  setTitle(null);
  tbActions.replaceChildren();
  const list = recents.list();
  const card = (r: Recent) =>
    h(
      "button",
      { class: "card", onclick: () => openFile(r.path), title: r.path },
      h(
        "div",
        { class: "card-thumb" },
        r.thumb
          ? h("img", {
              src: fileUrl(r.thumb),
              alt: "",
              draggable: "false",
              onerror: (e: Event) => (e.target as HTMLElement).remove(),
            })
          : icon(Film, 26, 1.5),
        r.duration
          ? h("span", { class: "card-dur" }, fmt(r.duration, false))
          : null
      ),
      h(
        "div",
        { class: "card-meta" },
        h("div", { class: "card-title" }, basename(r.path)),
        h("div", { class: "card-sub" }, ago(r.at))
      )
    );

  mainEl.replaceChildren(
    h(
      "div",
      { class: "home" },
      h(
        "div",
        { class: "home-inner" },
        h(
          "div",
          {
            class: "dropzone",
            role: "button",
            onclick: (e: MouseEvent) =>
              !(e.target as HTMLElement).closest("button, .chip") &&
              openDialog(),
          },
          h("div", { class: "dz-icon" }, icon(Upload, 22, 1.75)),
          h("h1", { class: "dz-title" }, "Drop a clip to start cutting"),
          h(
            "div",
            { class: "dz-sub" },
            "Trim, split and export without setting up a project."
          ),
          h(
            "button",
            { class: "btn btn-primary dz-open", onclick: openDialog },
            icon(FolderOpen, 16),
            "Open video",
            h("kbd", { class: "kbd-on-primary" }, "Ctrl O")
          ),
          h(
            "div",
            { class: "dz-foot" },
            h("span", {}, "MP4, MOV, MKV, WebM and more"),
            h("span", { class: "dot" }, "·"),
            toolsChip()
          )
        ),
        list.length
          ? h(
              "div",
              { class: "recent-head" },
              h("span", {}, "Recent clips"),
              h(
                "button",
                { class: "link", onclick: () => recents.save([]) },
                "Clear"
              )
            )
          : null,
        list.length
          ? h("div", { class: "recent-grid" }, ...list.slice(0, 6).map(card))
          : null
      )
    )
  );
}

// ---- opening files

export async function openDialog() {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Video", extensions: VIDEO_EXTS }],
  });
  if (typeof picked === "string") openFile(picked);
}

export function metaProbe(path: string): Promise<Probe | null> {
  return new Promise(resolve => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () =>
      resolve({
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
        fps: 30,
        vcodec: "",
        acodec: null,
        audioTracks: 0,
        audio: [],
        rotation: 0,
        size: 0,
        container: "",
      });
    v.onerror = () => resolve(null);
    v.src = fileUrl(path);
  });
}

export async function openFile(path: string) {
  if (session?.path === path) return;
  if (!VIDEO_EXTS.includes(ext(path))) {
    toast("That doesn't look like a video", { body: basename(path) });
    return;
  }
  const token = nextOpenToken();
  closeSession(false);
  setTitle(basename(path));
  mainEl.replaceChildren(
    h(
      "div",
      { class: "loading" },
      h("div", { class: "spinner" }),
      `Opening ${basename(path)}`
    )
  );

  let probe: Probe | null;
  setOpening(true);
  try {
    probe = await api.probe(path);
  } catch (err) {
    probe = await metaProbe(path);
    if (!probe && token === openToken) {
      setOpening(false);
      toast("Couldn't open video", { body: String(err), error: true });
      renderHome();
      return;
    }
  }
  const saved = store.settings.rememberEdits
    ? await api.loadEdit(path).catch(() => null)
    : null;
  if (token !== openToken || !probe) return;
  setOpening(false);
  if (!(probe.duration > 0)) {
    toast("Couldn't open video", {
      body: "Couldn't read how long the video is.",
      error: true,
    });
    renderHome();
    return;
  }

  buildEditor(path, probe, saved as Doc | null);
  const known = store.recents.find(r => r.path === path)?.thumb;
  recents.add({ path, at: Date.now(), duration: probe.duration, thumb: known });
  if (known) theme.banner(fileUrl(known));
  if (tools?.ffmpeg !== null) {
    api
      .thumbnail(path, Math.min(probe.duration * 0.1, 5))
      .then(thumb => {
        recents.update(path, { thumb });
        if (session?.path === path) theme.banner(fileUrl(thumb));
      })
      .catch(() => {});
  }
}

export function closeSession(goHome = true) {
  const s = session;
  if (s) {
    flushEditSave(s);
    s.alive = false;
    s.video.pause();
    s.video.removeAttribute("src");
    s.video.load();
    s.engine.destroy();
    s.tl.destroy();
    setSession(null);
    theme.banner(null);
  }
  if (goHome) {
    renderHome();
    renderSidebar();
  }
}

// ---- remembering cuts per clip

export let saveTimer = 0;
export let pendingSave: (() => Promise<void>) | null = null;

export function scheduleEditSave(s: Session) {
  if (!store.settings.rememberEdits) return;
  clearTimeout(saveTimer);
  pendingSave = () => {
    pendingSave = null;
    return api
      .saveEdit(s.path, s.edit.pristine() ? null : s.edit.doc())
      .catch(() => {});
  };
  saveTimer = window.setTimeout(() => pendingSave?.(), 600);
}

export function flushEditSave(_s: Session) {
  clearTimeout(saveTimer);
  return pendingSave?.() ?? Promise.resolve();
}

/** Write everything that's waiting to be saved: before closing, restarting or updating. */
export async function flushAll() {
  if (session) await flushEditSave(session);
  await flushSettings().catch(() => {});
}

/** A remembered edit only fits if it was made for a file of the same length. */
export function restorable(saved: Doc | null, probe: Probe): saved is Doc {
  if (!saved?.segs?.length || !Array.isArray(saved.tracks)) return false;
  const end = saved.segs[saved.segs.length - 1].end;
  return (
    Math.abs(end - probe.duration) < 0.05 &&
    saved.tracks.every(t => t.kind === "file" || t.index < probe.audio.length)
  );
}
