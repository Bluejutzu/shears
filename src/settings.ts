import { open } from "@tauri-apps/plugin-dialog";
import {
  ExternalLink,
  FolderOpen,
  HardDrive,
  History,
  Keyboard,
  Palette,
  RefreshCw,
  Save,
  Search,
  type IconNode,
} from "lucide";

import { api, REPO, type AppInfo, type Paths } from "./api";
import { hueName, type Theme, type ThemeName } from "./themes";
import type { M3Prefs } from "./themes/m3";
import {
  basename,
  dirname,
  fmtSize,
  h,
  icon,
  join,
  kbd,
  modal,
  row,
  stem,
  toast,
  toggle,
} from "./ui";

export type ExportPrefs = {
  copy: boolean;
  audio: "mix" | "separate" | "none";
  height: number | null;
  targetMb: number | null;
  gpu: boolean;
};

export type Settings = {
  /** null = next to the original file */
  exportDir: string | null;
  /** {name} is the original file name */
  exportName: string;
  frameDir: string | null;
  /** null = the app's own cache folder */
  cacheDir: string | null;
  maxRecents: number;
  rememberEdits: boolean;
  export: ExportPrefs;
  volumeDb: number;
  ui: {
    sidebarCollapsed: boolean;
    propsOpen: boolean;
    propsWidth: number;
    propsSide: "left" | "right";
    stageHeight: number | null;
    linkedSelection: boolean;
    /** media pool groups the user folded up */
    collapsed: string[];
    /** squeeze removed parts of the timeline down to thin markers */
    collapseRemoved: boolean;
  };
  /** folders whose videos always show up in the media pool */
  mediaFolders: string[];
  /** applies after a restart, only the active theme is loaded */
  theme: ThemeName;
  m3: M3Prefs;
  updates: {
    /** look for a new version on startup (release builds only) */
    auto: boolean;
    /** a version the user chose to skip */
    skipped: string | null;
    lastCheck: number;
  };
};

export type Recent = {
  path: string;
  at: number;
  duration: number;
  thumb?: string;
};

const DEFAULTS: Settings = {
  exportDir: null,
  exportName: "{name}_cut",
  frameDir: null,
  cacheDir: null,
  maxRecents: 15,
  rememberEdits: true,
  export: { copy: true, audio: "mix", height: null, targetMb: null, gpu: true },
  volumeDb: 0,
  ui: {
    sidebarCollapsed: false,
    propsOpen: true,
    propsWidth: 300,
    propsSide: "right",
    stageHeight: null,
    linkedSelection: true,
    collapsed: [],
    collapseRemoved: true,
  },
  mediaFolders: [],
  theme: "shears",
  m3: { hue: 220, intensity: 60, brightness: 50 },
  updates: { auto: true, skipped: null, lastCheck: 0 },
};

/** Everything that's saved to disk. Read at startup, written back (debounced) on change. */
export const store = {
  settings: structuredClone(DEFAULTS),
  recents: [] as Recent[],
  paths: { settings: "", data: "", cache: "", defaultCache: "" } as Paths,
  app: { name: "Shears", version: "", channel: "dev" } as AppInfo,
};

export async function loadState() {
  try {
    const s = await api.loadState();
    const saved = s.settings as Partial<Settings>;
    store.settings = {
      ...DEFAULTS,
      ...saved,
      export: { ...DEFAULTS.export, ...saved.export },
      ui: { ...DEFAULTS.ui, ...saved.ui },
      m3: { ...DEFAULTS.m3, ...saved.m3 },
      updates: { ...DEFAULTS.updates, ...saved.updates },
    };
    store.recents = Array.isArray(s.recents) ? (s.recents as Recent[]) : [];
    store.paths = s.paths;
    for (const file of s.broken ?? [])
      toast("A saved file couldn't be read", {
        body: `It was set aside as ${basename(file)} and Shears started fresh for it.`,
        error: true,
      });
  } catch (err) {
    toast("Couldn't load settings", { body: String(err), error: true });
  }
}

let saveTimer = 0;
export function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      store.paths.cache = await api.saveSettings(store.settings);
    } catch (err) {
      toast("Couldn't save settings", { body: String(err), error: true });
    }
  }, 250);
}

/** Write settings right away (before a restart) instead of waiting for the debounce. */
export async function flushSettings() {
  clearTimeout(saveTimer);
  store.paths.cache = await api.saveSettings(store.settings);
}

export function setRecents(list: Recent[]) {
  store.recents = list.slice(0, Math.max(0, store.settings.maxRecents));
  api.saveRecents(store.recents).catch(() => {});
}

/** Default export path for a source file, following the configured folder and name pattern. */
export function exportPath(source: string, extension: string) {
  const name = (store.settings.exportName.trim() || "{name}_cut")
    .split("{name}")
    .join(stem(source));
  return join(
    store.settings.exportDir ?? dirname(source),
    `${name}.${extension}`
  );
}

export function framePath(source: string, label: string) {
  return join(
    store.settings.frameDir ?? dirname(source),
    `${stem(source)}_${label}.png`
  );
}

// ---- settings screen

type SettingsHooks = {
  onChange: () => void;
  /** the theme that's loaded right now */
  theme: Theme;
  restart: () => void;
  /** live accent changes need the canvas timeline to pick up the new colors */
  colorsChanged: () => void;
  checkUpdates: () => void;
  /** every keyboard shortcut, with the keys already spelled out like "Ctrl Shift S" */
  shortcuts: () => { group: string; label: string; keys: string[] }[];
  section?: SectionId;
};

type SectionId =
  | "appearance"
  | "saving"
  | "history"
  | "storage"
  | "updates"
  | "shortcuts";

const SECTIONS: { id: SectionId; label: string; icon: IconNode }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "saving", label: "Saving", icon: Save },
  { id: "history", label: "History", icon: History },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard },
];

const SHORTCUT_GROUPS = ["Playback", "Editing", "Timeline", "General"];

/** Wrap every searched word in <mark>, skipping the text of inputs. */
function highlight(root: Node, words: string[]) {
  const re = new RegExp(
    words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi"
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (/\S/.test(n.nodeValue!)) hits.push(n as Text);
  for (const node of hits) {
    const text = node.nodeValue!;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index), h("mark", {}, m[0]));
      last = m.index + m[0].length;
    }
    if (!last) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

export function openSettings(hooks: SettingsHooks) {
  const { onChange } = hooks;
  const s = store.settings;
  const body = h("div", { class: "settings" });
  let cacheBytes: number | null = null;
  let active: SectionId = hooks.section ?? "appearance";
  let query = "";

  const pane = h("div", { class: "settings-pane" });
  const navList = h("div", { class: "settings-nav-list" });
  const search = h("input", {
    class: "input",
    placeholder: "Search",
    spellcheck: "false",
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      render();
      pane.scrollTop = 0;
    },
  });
  body.append(
    h(
      "div",
      { class: "settings-nav" },
      h("div", { class: "settings-search" }, icon(Search, 15), search),
      navList
    ),
    pane
  );

  const shortcuts = () => {
    const all = hooks.shortcuts();
    return [
      h(
        "div",
        { class: "sc-grid" },
        ...SHORTCUT_GROUPS.map(g =>
          h(
            "div",
            { class: "sc-group" },
            h("div", { class: "sc-title" }, g),
            ...all
              .filter(a => a.group === g)
              .map(a =>
                h(
                  "div",
                  {
                    class: "sc-row",
                    "data-search": `${a.label} ${a.keys.join(" ")}`,
                  },
                  h("span", {}, a.label),
                  h("span", { class: "sc-keys" }, ...a.keys.map(k => kbd(k)))
                )
              )
          )
        )
      ),
      h(
        "div",
        { class: "sc-foot" },
        "Timeline: click to seek, drag a cut line to move it, Ctrl + scroll to zoom, Shift + scroll to pan. Drag the line in an audio track to change its volume, drag added tracks and images sideways to move them, and drag an image's edge to change how long it shows. Hold Shift to skip snapping. Right-click anything for more."
      ),
    ];
  };

  const themeCard = (name: ThemeName, label: string) =>
    h(
      "button",
      {
        class: `theme-card${s.theme === name ? " active" : ""}`,
        onclick: () => {
          s.theme = name;
          saveSettings();
          render();
        },
      },
      h(
        "div",
        { class: `theme-preview ${name}` },
        h("i"),
        h(
          "div",
          { class: "tp-main" },
          h("i", { style: "height:16px" }),
          h("i", { style: "height:8px;width:70%" }),
          h("i", { class: "tp-accent" })
        )
      ),
      h("span", {}, label)
    );

  // sliders update in place so dragging them doesn't rebuild the whole screen
  const m3Slider = (
    label: string,
    key: keyof M3Prefs,
    min: number,
    max: number,
    show: (v: number) => string
  ) => {
    const value = h("span", { class: "value-label" }, show(s.m3[key]));
    return row(
      label,
      h(
        "div",
        { class: "gain-row" },
        h("input", {
          class: `range${key === "hue" ? " hue-range" : ""}`,
          type: "range",
          min: String(min),
          max: String(max),
          step: "1",
          value: String(s.m3[key]),
          oninput: (e: Event) => {
            s.m3[key] = +(e.target as HTMLInputElement).value;
            value.textContent = show(s.m3[key]);
            hooks.theme.apply(s.m3);
            hooks.colorsChanged();
            saveSettings();
          },
        }),
        value
      )
    );
  };

  const appearance = () => [
    h(
      "div",
      { class: "form" },
      row(
        "Theme",
        h(
          "div",
          {},
          h(
            "div",
            { class: "theme-cards" },
            themeCard("shears", "Shears"),
            themeCard("m3", "Material 3")
          ),
          s.theme !== hooks.theme.name
            ? h(
                "div",
                { class: "restart-note" },
                h(
                  "span",
                  {},
                  "Restart Shears to switch themes. Your open clip comes back."
                ),
                h(
                  "button",
                  { class: "btn btn-primary btn-sm", onclick: hooks.restart },
                  "Restart now"
                )
              )
            : null
        )
      ),
      ...(hooks.theme.name === "m3"
        ? [
            m3Slider("Accent", "hue", 0, 360, v => `${hueName(v)} (${v}°)`),
            m3Slider("Intensity", "intensity", 0, 100, v => `${v}%`),
            m3Slider("Brightness", "brightness", 25, 75, v => `${v}%`),
          ]
        : [])
    ),
  ];

  const changed = () => {
    saveSettings();
    onChange();
    render();
  };

  const pickFolder = async (current: string | null) => {
    const picked = await open({
      directory: true,
      defaultPath: current ?? undefined,
    });
    return typeof picked === "string" ? picked : null;
  };

  const folderRow = (
    label: string,
    value: string | null,
    fallback: string,
    set: (v: string | null) => void,
    hint?: string
  ) =>
    row(
      label,
      h(
        "div",
        { class: "file-pick" },
        h(
          "div",
          { class: "file-pick-path", title: value ?? fallback },
          h("span", { class: value ? "" : "dim" }, value ?? fallback)
        ),
        h(
          "button",
          {
            class: "btn btn-secondary btn-sm",
            onclick: async () => {
              const picked = await pickFolder(value);
              if (picked) {
                set(picked);
                changed();
              }
            },
          },
          "Change"
        ),
        value
          ? h(
              "button",
              {
                class: "btn btn-ghost btn-sm",
                onclick: () => {
                  set(null);
                  changed();
                },
              },
              "Reset"
            )
          : null
      ),
      hint
    );

  const refreshCache = () =>
    api
      .cacheSize()
      .then(b => {
        cacheBytes = b;
        render();
      })
      .catch(() => {});

  function render() {
    const preview = `${(s.exportName.trim() || "{name}_cut").split("{name}").join("clip")}.mp4`;
    const top = pane.scrollTop;
    const built: Record<SectionId, Node[]> = {
      appearance: appearance(),
      saving: [
        h(
          "div",
          { class: "form" },
          folderRow(
            "Exports",
            s.exportDir,
            "Next to the original video",
            v => (s.exportDir = v)
          ),
          row(
            "File name",
            h("input", {
              class: "input",
              value: s.exportName,
              spellcheck: "false",
              oninput: (e: Event) => {
                s.exportName = (e.target as HTMLInputElement).value;
                saveSettings();
                (
                  body.querySelector(".name-preview") as HTMLElement
                ).textContent =
                  `clip.mp4 → ${(s.exportName.trim() || "{name}_cut").split("{name}").join("clip")}.mp4`;
              },
            }),
            undefined
          ),
          h(
            "div",
            { class: "form-row" },
            h("div"),
            h(
              "div",
              { class: "form-hint name-preview" },
              `clip.mp4 → ${preview}  ·  {name} is the original file name`
            )
          ),
          folderRow(
            "Frames",
            s.frameDir,
            "Next to the original video",
            v => (s.frameDir = v),
            "Where Save frame (Ctrl Shift S) puts PNGs."
          )
        ),
      ],
      history: [
        h(
          "div",
          { class: "form" },
          row(
            "Remember cuts",
            h(
              "div",
              { class: "inline" },
              toggle(
                s.rememberEdits,
                on => ((s.rememberEdits = on), changed())
              ),
              h(
                "span",
                { class: "dim small" },
                "Reopening a clip brings back your cuts, marks and track settings"
              )
            )
          ),
          row(
            "Recent clips",
            h(
              "div",
              { class: "inline" },
              h("input", {
                class: "input input-sm",
                type: "number",
                min: "0",
                max: "50",
                value: String(s.maxRecents),
                onchange: (e: Event) => {
                  s.maxRecents = Math.max(
                    0,
                    Math.min(
                      50,
                      Math.round(+(e.target as HTMLInputElement).value || 0)
                    )
                  );
                  setRecents(store.recents);
                  changed();
                },
              }),
              h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  onclick: () => (setRecents([]), changed()),
                },
                "Clear recents"
              ),
              h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  onclick: async () => {
                    await api.forgetEdits();
                    toast("Saved cuts cleared");
                  },
                },
                "Forget saved cuts"
              )
            )
          )
        ),
      ],
      storage: [
        h(
          "div",
          { class: "form" },
          folderRow(
            "Cache",
            s.cacheDir,
            store.paths.defaultCache,
            v => {
              s.cacheDir = v;
              setTimeout(refreshCache, 400);
            },
            "Thumbnails, preview copies and extracted audio. Safe to clear any time."
          ),
          row(
            "",
            h(
              "div",
              { class: "inline" },
              h(
                "span",
                { class: "dim small" },
                cacheBytes == null
                  ? "Measuring…"
                  : `Using ${fmtSize(cacheBytes)}`
              ),
              h(
                "button",
                {
                  class: "btn btn-secondary btn-sm",
                  onclick: async () => {
                    await api.clearCache();
                    refreshCache();
                    toast("Cache cleared");
                  },
                },
                "Clear cache"
              ),
              h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  onclick: () => api.openFolder(store.paths.cache),
                },
                icon(FolderOpen, 14),
                "Open"
              )
            )
          ),
          row(
            "App data",
            h(
              "div",
              { class: "inline" },
              h(
                "span",
                { class: "dim small path-text", title: store.paths.data },
                store.paths.data
              ),
              h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  onclick: () => api.openFolder(store.paths.data),
                },
                icon(FolderOpen, 14),
                "Open"
              )
            ),
            `Recents and remembered cuts. Settings are in ${basename(store.paths.settings)} in ${dirname(store.paths.settings)}.`
          )
        ),
      ],
      updates: updates(),
      shortcuts: shortcuts(),
    };

    navList.replaceChildren(
      ...SECTIONS.map(sec =>
        h(
          "button",
          {
            class: `settings-tab${!query && sec.id === active ? " active" : ""}`,
            onclick: () => {
              active = sec.id;
              query = search.value = "";
              render();
              pane.scrollTop = 0;
            },
          },
          icon(sec.icon, 18),
          h("span", {}, sec.label)
        )
      )
    );

    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      pane.replaceChildren(
        h(
          "div",
          { class: "settings-title" },
          SECTIONS.find(x => x.id === active)!.label
        ),
        ...built[active]
      );
      pane.scrollTop = top;
      return;
    }

    // searching: show every section, keeping only the rows that contain all the words
    const found: Node[] = [];
    for (const sec of SECTIONS) {
      const part = h("div", {}, ...built[sec.id]);
      for (const r of part.querySelectorAll<HTMLElement>(
        ".form-row, .sc-row"
      )) {
        const text = (r.dataset.search ?? r.textContent ?? "").toLowerCase();
        if (!words.every(w => text.includes(w))) r.remove();
      }
      for (const g of part.querySelectorAll(".sc-group"))
        if (!g.querySelector(".sc-row")) g.remove();
      if (!part.querySelector(".form-row, .sc-row")) continue;
      part.querySelector(".sc-foot")?.remove();
      found.push(h("div", { class: "settings-section" }, sec.label), part);
    }
    pane.replaceChildren(
      ...(found.length
        ? found
        : [
            h(
              "div",
              { class: "settings-empty" },
              `Nothing matches "${query.trim()}"`
            ),
          ])
    );
    highlight(pane, words);
    pane.scrollTop = top;
  }

  const updates = () => {
    const release = store.app.channel === "release";
    return [
      h(
        "div",
        { class: "form" },
        row(
          "Version",
          h(
            "div",
            { class: "inline" },
            h("span", {}, `${store.app.name} ${store.app.version}`),
            h(
              "span",
              { class: `chip${release ? "" : " warn"}` },
              release ? "Release" : "Dev build"
            ),
            h("div", { class: "spacer" }),
            h(
              "button",
              {
                class: "btn btn-secondary btn-sm",
                disabled: !release,
                onclick: hooks.checkUpdates,
              },
              icon(RefreshCw, 14),
              "Check now"
            )
          ),
          release
            ? s.updates.lastCheck
              ? `Last checked ${new Date(s.updates.lastCheck).toLocaleString()}.`
              : undefined
            : "Local builds don't update themselves and keep their own settings, so they can sit next to the public release."
        ),
        release &&
          row(
            "Automatically",
            h(
              "div",
              { class: "inline" },
              toggle(s.updates.auto, on => ((s.updates.auto = on), changed())),
              h(
                "span",
                { class: "dim small" },
                "Look for a new version when Shears starts"
              )
            )
          ),
        row(
          "Links",
          h(
            "div",
            { class: "inline" },
            h(
              "button",
              {
                class: "btn btn-ghost btn-sm",
                onclick: () => api.openUrl(`${REPO}/releases`),
              },
              icon(ExternalLink, 14),
              "Release notes"
            ),
            h(
              "button",
              {
                class: "btn btn-ghost btn-sm",
                onclick: () => api.openUrl(`${REPO}/issues/new`),
              },
              icon(ExternalLink, 14),
              "Report a problem"
            )
          )
        )
      ),
    ];
  };

  render();
  refreshCache();
  modal("Settings", body, { wide: true }).card.classList.add("settings-modal");
}
