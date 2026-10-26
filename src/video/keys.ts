import { menuOpen, modalOpen } from "../shared/ui";
import {
  copySelection,
  del,
  deselect,
  doExport,
  duplicate,
  keepRange,
  markIn,
  markOut,
  nextCut,
  paste,
  prevCut,
  saveFrame,
  seek,
  seekBy,
  selectAll,
  shiftRate,
  split,
  stepFrame,
  toggleMute,
  togglePlay,
  toggleSidebar,
  trimAfter,
  trimBefore,
} from "./actions";
import { openSettingsAt, showSettings } from "./chrome";
import { addAudioTrack, addImage } from "./editor";
import { closeSession, openDialog } from "./home";
import {
  showInfo,
  showMetadata,
  toggleCollapseRemoved,
  toggleLinkedSelection,
  toggleProps,
} from "./panels";
import { appMode, session } from "./state";

// ---- keyboard

export type Action = {
  label: string;
  keys: string[];
  group: string;
  run: () => void;
  editor?: boolean;
};

export const actions: Action[] = [
  {
    group: "Playback",
    label: "Play / pause",
    keys: ["space", "k"],
    run: togglePlay,
    editor: true,
  },
  {
    group: "Playback",
    label: "Back / forward 5 seconds",
    keys: ["j", "l"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Previous / next frame",
    keys: ["arrowleft", "arrowright"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Back / forward 1 second",
    keys: ["shift+arrowleft", "shift+arrowright"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Previous / next cut",
    keys: ["arrowup", "arrowdown"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Go to start / end",
    keys: ["home", "end"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Slower / faster",
    keys: ["<", ">"],
    run: () => {},
    editor: true,
  },
  {
    group: "Playback",
    label: "Mute preview",
    keys: ["m"],
    run: toggleMute,
    editor: true,
  },
  {
    group: "Editing",
    label: "Split at playhead",
    keys: ["s", "ctrl+b"],
    run: split,
    editor: true,
  },
  {
    group: "Editing",
    label: "Remove / restore part (or marked range)",
    keys: ["delete", "backspace"],
    run: del,
    editor: true,
  },
  {
    group: "Editing",
    label: "Trim part start to playhead",
    keys: ["q"],
    run: trimBefore,
    editor: true,
  },
  {
    group: "Editing",
    label: "Trim part end from playhead",
    keys: ["w"],
    run: trimAfter,
    editor: true,
  },
  {
    group: "Editing",
    label: "Mark in / out",
    keys: ["i", "o"],
    run: () => {},
    editor: true,
  },
  {
    group: "Editing",
    label: "Keep only marked range",
    keys: ["t"],
    run: keepRange,
    editor: true,
  },
  {
    group: "Editing",
    label: "Clear marks",
    keys: ["alt+x"],
    run: () => session?.edit.clearMarks(),
    editor: true,
  },
  {
    group: "Editing",
    label: "Cut / copy / paste image or audio",
    keys: ["ctrl+x", "ctrl+c", "ctrl+v"],
    run: () => {},
    editor: true,
  },
  {
    group: "Editing",
    label: "Duplicate",
    keys: ["ctrl+d"],
    run: duplicate,
    editor: true,
  },
  {
    group: "Editing",
    label: "Select all",
    keys: ["ctrl+a"],
    run: selectAll,
    editor: true,
  },
  {
    group: "Editing",
    label: "Undo",
    keys: ["ctrl+z"],
    run: () => session?.edit.undo(),
    editor: true,
  },
  {
    group: "Editing",
    label: "Redo",
    keys: ["ctrl+shift+z", "ctrl+y"],
    run: () => session?.edit.redo(),
    editor: true,
  },
  {
    group: "Editing",
    label: "Deselect",
    keys: ["escape"],
    run: deselect,
    editor: true,
  },
  {
    group: "Timeline",
    label: "Zoom in / out",
    keys: ["+", "-"],
    run: () => {},
    editor: true,
  },
  {
    group: "Timeline",
    label: "Fit whole clip",
    keys: ["\\"],
    run: () => session?.tl.fit(),
    editor: true,
  },
  {
    group: "Timeline",
    label: "Add audio track",
    keys: ["ctrl+shift+a"],
    run: () => addAudioTrack(),
    editor: true,
  },
  {
    group: "Timeline",
    label: "Add image",
    keys: ["ctrl+shift+i"],
    run: () => addImage(),
    editor: true,
  },
  {
    group: "Timeline",
    label: "Linked selection on / off",
    keys: ["ctrl+shift+l"],
    run: toggleLinkedSelection,
    editor: true,
  },
  {
    group: "Timeline",
    label: "Collapse / show removed parts",
    keys: ["h"],
    run: toggleCollapseRemoved,
    editor: true,
  },
  { group: "General", label: "Open video", keys: ["ctrl+o"], run: openDialog },
  {
    group: "General",
    label: "Export",
    keys: ["ctrl+e"],
    run: doExport,
    editor: true,
  },
  {
    group: "General",
    label: "Save current frame",
    keys: ["ctrl+shift+s"],
    run: saveFrame,
    editor: true,
  },
  {
    group: "General",
    label: "Close video",
    keys: ["ctrl+w"],
    run: () => closeSession(),
    editor: true,
  },
  {
    group: "General",
    label: "Inspector panel",
    keys: ["ctrl+p"],
    run: toggleProps,
    editor: true,
  },
  {
    group: "General",
    label: "Clip info",
    keys: ["ctrl+i"],
    run: showInfo,
    editor: true,
  },
  {
    group: "General",
    label: "Edit metadata",
    keys: ["ctrl+shift+m"],
    run: showMetadata,
    editor: true,
  },
  {
    group: "General",
    label: "Toggle sidebar",
    keys: ["ctrl+."],
    run: toggleSidebar,
  },
  { group: "General", label: "Settings", keys: ["ctrl+,"], run: showSettings },
  {
    group: "General",
    label: "Keyboard shortcuts",
    keys: ["?"],
    run: showShortcuts,
  },
];

// paired keys (j / l etc.) share one row in the shortcut list but each does its own thing
export const keymap = new Map<string, Action>();
export const pairs: Record<string, () => void> = {
  j: () => seekBy(-5),
  l: () => seekBy(5),
  arrowleft: () => stepFrame(-1),
  arrowright: () => stepFrame(1),
  "shift+arrowleft": () => seekBy(-1),
  "shift+arrowright": () => seekBy(1),
  arrowup: prevCut,
  arrowdown: nextCut,
  home: () => seek(0),
  end: () => seek(session?.probe.duration ?? 0),
  "<": () => shiftRate(-1),
  ">": () => shiftRate(1),
  i: markIn,
  o: markOut,
  "ctrl+x": () => copySelection(true),
  "ctrl+c": () => copySelection(),
  "ctrl+v": () => paste(),
  "+": () => session?.tl.zoomBy(1.5),
  "=": () => session?.tl.zoomBy(1.5),
  "-": () => session?.tl.zoomBy(1 / 1.5),
};
for (const a of actions)
  for (const k of a.keys) keymap.set(k, pairs[k] ? { ...a, run: pairs[k] } : a);
keymap.set("=", { ...keymap.get("+")!, run: pairs["="] });

export function comboOf(e: KeyboardEvent) {
  const key = e.key === " " ? "space" : e.key.toLowerCase();
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && !symbol) mods.push("shift");
  return [...mods, key].join("+");
}

export const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  space: "Space",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  delete: "Del",
  backspace: "⌫",
  escape: "Esc",
  home: "Home",
  end: "End",
};
export const keyLabel = (combo: string) =>
  combo
    .split(/\+(?!$)/)
    .map(k => KEY_NAMES[k] ?? k.toUpperCase())
    .join(" ");

document.addEventListener("keydown", e => {
  if (appMode !== "video" || modalOpen() || menuOpen()) return;
  const t = e.target as HTMLElement;
  if (
    (t instanceof HTMLInputElement && t.type !== "range") ||
    t instanceof HTMLTextAreaElement ||
    t.isContentEditable
  )
    return;
  const a = keymap.get(comboOf(e));
  if (!a || (a.editor && !session)) return;
  e.preventDefault();
  a.run();
});

export function showShortcuts() {
  openSettingsAt("shortcuts");
}
