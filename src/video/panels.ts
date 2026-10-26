import { listen } from "@tauri-apps/api/event";
import { TriangleAlert, Volume1, Volume2, VolumeX } from "lucide";

import { api, fileUrl, type JobProgress, type MetaEdit } from "../shared/api";
import { openMetadata } from "../shared/metadata";
import { saveSettings, store } from "../shared/settings";
import {
  basename,
  fmt,
  fmtDb,
  h,
  icon,
  progressBar,
  toast,
} from "../shared/ui";
import { scheduleProps } from "./editor";
import { showClipInfo } from "./props";
import { clamp, session, Session, tools } from "./state";

export function waitFor(el: HTMLMediaElement, event: string, timeout = 4000) {
  return new Promise<boolean>(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(false), timeout);
    el.addEventListener(event, onOk);
    el.addEventListener("error", onErr);
  });
}

/** Fill the filmstrip using a hidden second player, coarse first so the whole strip shows up quickly. */
export async function genThumbs(s: Session, src: string) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = src;
  if (!(await waitFor(v, "loadeddata"))) return;
  const dur = s.probe.duration;
  const step = Math.max(0.5, dur / 150);
  const n = Math.max(1, Math.ceil(dur / step));
  s.tl.thumbStep = step;
  s.tl.thumbs = new Array(n);
  const H = Math.round(56 * devicePixelRatio);
  const W = Math.round(H * s.tl.aspect);
  const order: number[] = [];
  const seen = new Set<number>();
  for (const stride of [16, 4, 1]) {
    for (let i = 0; i < n; i += stride) {
      if (!seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    }
  }
  for (const i of order) {
    if (!s.alive) break;
    v.currentTime = Math.min(i * step + 0.05, Math.max(0, dur - 0.1));
    if (!(await waitFor(v, "seeked"))) continue;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d")!.drawImage(v, 0, 0, W, H);
    s.tl.thumbs[i] = c;
    s.tl.invalidate();
  }
  v.removeAttribute("src");
  v.load();
}

export let stageProgress = (_p: number) => {};

export function showStageMsg(
  s: Session,
  title: string,
  body: string,
  progress = false
) {
  const el = s.els.stageMsg;
  el.hidden = false;
  const bar = progressBar();
  stageProgress = bar.set;
  el.replaceChildren(
    h(
      "div",
      { class: "stage-card" },
      progress ? h("div", { class: "spinner" }) : icon(TriangleAlert, 22),
      h("div", { class: "stage-title" }, title),
      h("div", { class: "stage-body" }, body),
      progress ? bar.el : null
    )
  );
}

export async function previewFallback(s: Session) {
  if (!s.alive || !s.video.getAttribute("src")) return;
  if (s.previewStage >= 2 || !tools?.ffmpeg) {
    showStageMsg(
      s,
      "Can't preview this video",
      "The built-in player doesn't support its format, and ffmpeg isn't available to make a preview copy."
    );
    return;
  }
  s.previewStage++;
  const transcode = s.previewStage === 2;
  showStageMsg(
    s,
    transcode ? "Making a preview copy" : "Preparing preview",
    transcode
      ? "The player can't decode this codec, so Shears is making a light copy just for previewing. Exports still use the original."
      : "Repackaging the file so the player can read it. Exports still use the original.",
    true
  );
  const unlisten = await listen<JobProgress>("job-progress", e => {
    stageProgress(e.payload.p);
  });
  try {
    const preview = await api.makePreview(s.path, s.probe.duration, transcode);
    if (s.alive) {
      s.thumbsStarted = false;
      s.video.src = fileUrl(preview);
    }
  } catch (err) {
    if (s.alive) showStageMsg(s, "Can't preview this video", String(err));
  } finally {
    unlisten();
  }
}

export function updateUI(s: Session) {
  const e = s.edit;
  const kept = e.kept();
  const removed = s.probe.duration - e.outDuration();
  s.els.out.replaceChildren(
    h("span", { class: "dim" }, "Output "),
    h("span", {}, fmt(e.outDuration())),
    h(
      "span",
      { class: "dim" },
      `  ·  ${kept.length} ${kept.length === 1 ? "part" : "parts"}`
    ),
    removed > 0.001
      ? h("span", { class: "dim" }, `  ·  ${fmt(removed)} removed`)
      : ""
  );
  s.els.undo.disabled = !e.canUndo;
  s.els.redo.disabled = !e.canRedo;
  s.els.keep.disabled = !e.range();
}

export function updateVolumeUI(s: Session) {
  const db = store.settings.volumeDb;
  const off = s.muted || db <= -40;
  s.els.vol.replaceChildren(
    icon(off ? VolumeX : db < -12 ? Volume1 : Volume2, 16)
  );
  s.els.volRange.value = String(db);
  s.els.volLabel.textContent = db <= -40 ? "Off" : fmtDb(db);
  s.els.volLabel.classList.toggle("dim", off);
}

export function setVolume(db: number) {
  const s = session;
  db = Math.round(clamp(db, -40, 12) * 2) / 2;
  store.settings.volumeDb = db;
  saveSettings();
  if (!s) return;
  s.engine.setMaster(db, s.muted);
  updateVolumeUI(s);
}

export function toggleProps() {
  const ui = store.settings.ui;
  ui.propsOpen = !ui.propsOpen;
  saveSettings();
  document
    .querySelector(".workspace")
    ?.classList.toggle("props-hidden", !ui.propsOpen);
  if (session) scheduleProps(session);
}

export function showInfo() {
  if (session)
    showClipInfo(
      session.path,
      session.probe,
      session.edit.tracks,
      showMetadata
    );
}

export function showMetadata() {
  const s = session;
  if (!s) return;
  s.video.pause();
  openMetadata({
    path: s.path,
    edit: s.edit,
    write: (m, out) => writeMetadata(s, m, out),
  });
}

/** Write tags into the clip's file. The preview lets go of the file while it gets swapped. */
export async function writeMetadata(
  s: Session,
  m: MetaEdit,
  output: string | null
) {
  const v = s.video;
  const t = v.currentTime;
  v.pause();
  v.removeAttribute("src");
  v.load();
  try {
    await api.writeMetadata(s.path, output, m);
    toast("Metadata written", { body: basename(output ?? s.path) });
    return true;
  } catch (err) {
    toast("Couldn't write metadata", { body: String(err), error: true });
    return false;
  } finally {
    if (session === s) {
      // the file's bytes moved around, so make sure the player doesn't reuse what it cached
      v.src = `${fileUrl(s.path)}?v=${Date.now()}`;
      v.addEventListener("loadedmetadata", () => (v.currentTime = t), {
        once: true,
      });
    }
  }
}

export function toggleCollapseRemoved() {
  const ui = store.settings.ui;
  ui.collapseRemoved = !ui.collapseRemoved;
  saveSettings();
  document
    .getElementById("collapse-toggle")
    ?.classList.toggle("on", ui.collapseRemoved);
  session?.tl.fit();
}

export function toggleLinkedSelection() {
  const ui = store.settings.ui;
  ui.linkedSelection = !ui.linkedSelection;
  saveSettings();
  document
    .getElementById("link-toggle")
    ?.classList.toggle("on", ui.linkedSelection);
  toast(ui.linkedSelection ? "Linked selection on" : "Linked selection off", {
    body: ui.linkedSelection
      ? "Clicking the video or a linked track selects them together."
      : "Clicking a lane selects just that lane.",
  });
}

/** Drag the inspector by its title and drop it on the left or right of the editor. */
export function startDock(
  e: PointerEvent,
  workspace: HTMLElement,
  editorCol: HTMLElement,
  props: HTMLElement
) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLElement | null = null;
  let marker: HTMLElement | null = null;
  let side = store.settings.ui.propsSide;

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      ghost = h("div", { class: "dock-ghost" }, "Inspector");
      marker = h("div", { class: "dock-marker" });
      document.body.append(ghost);
      workspace.append(marker);
      props.classList.add("lifting");
    }
    const r = workspace.getBoundingClientRect();
    side = ev.clientX < r.left + r.width / 2 ? "left" : "right";
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    marker!.className = `dock-marker show ${side}`;
    marker!.style.width = `${props.offsetWidth}px`;
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!ghost) return;
    ghost.classList.add("leaving");
    setTimeout(() => ghost?.remove(), 160);
    marker?.remove();
    props.classList.remove("lifting");
    if (side === store.settings.ui.propsSide) return;

    // swap sides, then slide both panes from their old spots into the new ones
    const before = [editorCol, props].map(
      el => el.getBoundingClientRect().left
    );
    store.settings.ui.propsSide = side;
    saveSettings();
    workspace.classList.toggle("props-left", side === "left");
    [editorCol, props].forEach((el, i) => {
      const dx = before[i] - el.getBoundingClientRect().left;
      el.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
        { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    });
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- render loop: skip removed parts during playback and keep the UI in sync

export let lastClock = "";
export function loop() {
  const s = session;
  if (s) {
    const v = s.video;
    const t = v.currentTime;
    if (!v.paused && !v.seeking && !s.edit.isKept(t)) {
      const next = s.edit.nextKept(t);
      if (next == null) {
        v.pause();
        const kept = s.edit.kept();
        if (kept.length) v.currentTime = kept[kept.length - 1][1];
      } else {
        v.currentTime = next;
      }
    }
    s.engine.sync(s.edit.tracks);
    s.layer.tick(t);
    if (!v.paused) s.tl.follow(t);
    s.tl.render();
    const clock = fmt(t);
    if (clock !== lastClock) {
      s.els.cur.textContent = clock;
      lastClock = clock;
    }
    s.els.badge.hidden = !v.paused || s.edit.isKept(t);
  }
  requestAnimationFrame(loop);
}
