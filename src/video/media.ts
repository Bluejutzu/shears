import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronRight,
  Copy,
  Ellipsis,
  FileMusic,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Play,
  RefreshCw,
  X,
} from "lucide";

import { api, fileUrl, type MediaFile } from "../shared/api";
import { saveSettings, store } from "../shared/settings";
import {
  ago,
  basename,
  fmt,
  fmtSize,
  h,
  icon,
  menu,
  toast,
  type MenuItem,
} from "../shared/ui";

type Info = { duration: number; thumb: string | null };

const POLL_MS = 4000;
const listings = new Map<string, MediaFile[] | { error: string }>();
const infos = new Map<string, Info>();
const pending = new Set<string>();
const queue: { key: string; path: string }[] = [];
let active = 0;
let changed: () => void = () => {};

const infoKey = (path: string, modified = 0) => `${path}|${modified}`;

/** Look for new or removed videos in the watched folders, and redraw if anything changed. */
export async function refreshMedia() {
  let dirty = false;
  const folders = store.settings.mediaFolders;
  for (const dir of [...listings.keys()]) {
    if (!folders.includes(dir)) {
      listings.delete(dir);
      dirty = true;
    }
  }
  await Promise.all(
    folders.map(async dir => {
      let next: MediaFile[] | { error: string };
      try {
        next = await api.listMedia(dir);
      } catch (err) {
        next = { error: String(err) };
      }
      const prev = listings.get(dir);
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        listings.set(dir, next);
        dirty = true;
      }
    })
  );
  if (dirty) changed();
}

/** Every video in the watched folders. */
export function poolVideos() {
  return [...listings.values()].flatMap(l => (Array.isArray(l) ? l : []));
}

export function startMediaWatch(onChange: () => void) {
  changed = onChange;
  refreshMedia();
  setInterval(() => {
    if (
      document.visibilityState === "visible" &&
      store.settings.mediaFolders.length
    )
      refreshMedia();
  }, POLL_MS);
  window.addEventListener("focus", () => refreshMedia());
}

export async function addMediaFolder(dir?: string) {
  if (!dir) {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    dir = picked;
  }
  if (store.settings.mediaFolders.includes(dir)) {
    toast("Already in the media pool", { body: dir });
    return;
  }
  store.settings.mediaFolders = [...store.settings.mediaFolders, dir];
  saveSettings();
  await refreshMedia();
}

function removeFolder(dir: string) {
  store.settings.mediaFolders = store.settings.mediaFolders.filter(
    d => d !== dir
  );
  saveSettings();
  refreshMedia();
}

// thumbnails and durations load lazily for items that scroll into view, two at a time
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target as HTMLElement;
    observer.unobserve(el);
    const key = el.dataset.key!;
    if (!infos.has(key) && !pending.has(key)) {
      pending.add(key);
      queue.push({ key, path: el.dataset.path! });
      pump();
    }
  }
});

function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift()!;
    active++;
    api
      .mediaInfo(job.path)
      .then(info => {
        infos.set(job.key, info);
        for (const el of document.querySelectorAll<HTMLElement>(
          `.media-item[data-key="${CSS.escape(job.key)}"]`
        ))
          fillInfo(el, info);
      })
      .catch(() => infos.set(job.key, { duration: 0, thumb: null }))
      .finally(() => {
        pending.delete(job.key);
        active--;
        pump();
      });
  }
}

// reused across redraws so thumbnails don't reload and flash
const thumbImgs = new Map<string, HTMLImageElement>();

function fillInfo(el: HTMLElement, info: Info) {
  const thumb = el.querySelector(".media-thumb")!;
  if (info.thumb) {
    let img = thumbImgs.get(info.thumb);
    if (!img || img.isConnected) {
      img = h("img", {
        src: fileUrl(info.thumb),
        alt: "",
        draggable: "false",
      }) as HTMLImageElement;
      thumbImgs.set(info.thumb, img);
    }
    thumb.replaceChildren(img);
  }
  const dur = el.querySelector(".media-dur");
  if (dur && info.duration) dur.textContent = fmt(info.duration, false);
}

type ItemOpts = {
  path: string;
  name: string;
  meta: string;
  key: string;
  current: boolean;
  open: () => void;
  /** add this file's audio to the open clip as a new track */
  addAudio?: () => void;
  actions: MenuItem[];
};

function item(o: ItemOpts) {
  const more = h(
    "button",
    {
      class: "icon-btn sm more",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        menu(more, o.actions);
      },
    },
    icon(Ellipsis, 15)
  );
  const el = h(
    "div",
    {
      class: `media-item${o.current ? " active" : ""}`,
      role: "button",
      title: o.path,
      "data-key": o.key,
      "data-path": o.path,
      onclick: o.open,
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        menu({ x: e.clientX, y: e.clientY }, [
          { label: "Open", icon: Play, disabled: o.current, run: o.open },
          !o.current &&
            !!o.addAudio && {
              label: "Add its audio as a track",
              icon: FileMusic,
              run: o.addAudio,
            },
          {
            label: "Copy path",
            icon: Copy,
            run: () => navigator.clipboard?.writeText(o.path),
          },
          "sep",
          ...o.actions,
        ]);
      },
    },
    h("div", { class: "media-thumb" }, icon(Film, 16, 1.5)),
    h(
      "div",
      { class: "media-text" },
      h("div", { class: "media-name" }, o.name),
      h(
        "div",
        { class: "media-meta" },
        h("span", { class: "media-dur" }),
        o.meta
      )
    ),
    more
  );
  const info = infos.get(o.key);
  if (info) fillInfo(el, info);
  else observer.observe(el);
  return el;
}

function group(
  id: string,
  title: string,
  count: number | null,
  children: Node[],
  extra: Node | null = null,
  items: MenuItem[] = []
) {
  const collapsed = store.settings.ui.collapsed.includes(id);
  const toggle = () => {
    const list = store.settings.ui.collapsed;
    store.settings.ui.collapsed = collapsed
      ? list.filter(x => x !== id)
      : [...list, id];
    saveSettings();
    changed();
  };
  return h(
    "div",
    { class: `media-group${collapsed ? " collapsed" : ""}` },
    h(
      "div",
      {
        class: "media-group-head",
        role: "button",
        onclick: toggle,
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          menu({ x: e.clientX, y: e.clientY }, [
            {
              label: collapsed ? "Expand" : "Collapse",
              icon: ChevronRight,
              run: toggle,
            },
            "sep",
            ...items,
          ]);
        },
      },
      h("span", { class: "chev" }, icon(ChevronRight, 14)),
      h("span", { class: "media-group-title", title }, title),
      count != null ? h("span", { class: "media-count" }, String(count)) : null,
      extra
    ),
    collapsed ? null : h("div", { class: "media-items" }, ...children)
  );
}

export function renderMediaPool(opts: {
  current: string | null;
  open: (path: string) => void;
  removeRecent: (path: string) => void;
  addAudio?: (path: string) => void;
}) {
  const addAudio = (path: string) =>
    opts.addAudio && (() => opts.addAudio!(path));
  const groups: Node[] = [];
  const recents = store.recents;
  if (recents.length) {
    groups.push(
      group(
        "recent",
        "Recent",
        recents.length,
        recents.map(r =>
          item({
            path: r.path,
            name: basename(r.path),
            meta: ago(r.at),
            key: infoKey(r.path),
            current: opts.current === r.path,
            open: () => opts.open(r.path),
            addAudio: addAudio(r.path),
            actions: [
              {
                label: "Show in folder",
                icon: FolderOpen,
                run: () => api.reveal(r.path),
              },
              {
                label: "Remove from recents",
                icon: X,
                danger: true,
                run: () => opts.removeRecent(r.path),
              },
            ],
          })
        )
      )
    );
  }

  for (const dir of store.settings.mediaFolders) {
    const listing = listings.get(dir);
    const files = Array.isArray(listing) ? listing : [];
    const folderItems: MenuItem[] = [
      {
        label: "Open folder",
        icon: FolderOpen,
        run: () => api.openFolder(dir),
      },
      { label: "Refresh", icon: RefreshCw, run: () => refreshMedia() },
      {
        label: "Remove from media pool",
        icon: X,
        danger: true,
        run: () => removeFolder(dir),
      },
    ];
    const folderMenu = h(
      "button",
      {
        class: "icon-btn sm more",
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          menu(folderMenu, folderItems);
        },
      },
      icon(Ellipsis, 15)
    );
    const children = !listing
      ? [h("div", { class: "media-note" }, "Looking…")]
      : "error" in listing
        ? [h("div", { class: "media-note warn" }, "Can't read this folder")]
        : files.length
          ? files.map(f =>
              item({
                path: f.path,
                name: f.name,
                meta: fmtSize(f.size),
                key: infoKey(f.path, f.modified),
                current: opts.current === f.path,
                open: () => opts.open(f.path),
                addAudio: addAudio(f.path),
                actions: [
                  {
                    label: "Show in folder",
                    icon: FolderOpen,
                    run: () => api.reveal(f.path),
                  },
                ],
              })
            )
          : [h("div", { class: "media-note" }, "No videos in here yet")];
    groups.push(
      group(
        dir,
        basename(dir) || dir,
        files.length,
        children,
        folderMenu,
        folderItems
      )
    );
  }

  return h(
    "div",
    { class: "media-pool" },
    h(
      "div",
      { class: "sb-section media-head" },
      h("span", {}, "Media pool"),
      h(
        "button",
        {
          class: "icon-btn sm",
          "data-tip": "Add a folder: its videos always show up here",
          onclick: () => addMediaFolder(),
        },
        icon(FolderPlus, 15)
      )
    ),
    h(
      "div",
      { class: "media-scroll" },
      ...groups,
      store.settings.mediaFolders.length
        ? null
        : h(
            "button",
            { class: "media-empty", onclick: () => addMediaFolder() },
            icon(Folder, 18, 1.5),
            h("span", {}, "Add a folder"),
            h(
              "span",
              { class: "dim small" },
              "Point it at your recordings folder and new clips show up here on their own. You can also drop a folder onto the window."
            )
          )
    )
  );
}
