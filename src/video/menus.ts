import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  BringToFront,
  Camera,
  ChevronsRightLeft,
  ClipboardPaste,
  Clock,
  Copy,
  CopyPlus,
  Crop,
  Crosshair,
  FileMusic,
  Film,
  FolderOpen,
  FoldHorizontal,
  Headphones,
  Image as ImageIcon,
  ImagePlus,
  Info,
  Link2,
  ListRestart,
  Maximize,
  MoveHorizontal,
  PanelRight,
  Pause,
  Play,
  Plus,
  Redo2,
  Replace,
  RotateCw,
  Scan,
  Scissors,
  ScissorsLineDashed,
  SendToBack,
  SquareDashedMousePointer,
  Tags,
  Trash,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide";

import { api } from "../shared/api";
import { store } from "../shared/settings";
import { fmt, fmtDb, menu, type MenuItem } from "../shared/ui";
import {
  clipboard,
  copySelection,
  copyTimecode,
  deleteSelection,
  duplicate,
  keepRange,
  paste,
  removableIds,
  replaceImage,
  saveFrame,
  seek,
  selectAll,
  selectedItems,
  time,
  togglePlay,
} from "./actions";
import { addFromLibrary } from "./chrome";
import { type Look, type Overlay, type Track } from "./edit";
import { addAudioTrack, addImage, frameSize, scheduleProps } from "./editor";
import { keyLabel } from "./keys";
import { getImage } from "./overlays";
import {
  showInfo,
  showMetadata,
  toggleCollapseRemoved,
  toggleLinkedSelection,
  toggleProps,
} from "./panels";
import { type InspectorTab, setInspectorTab } from "./props";
import { clamp, MarkIn, MarkOut, session } from "./state";
import { type Target } from "./timeline";

// ---- right-click menus: a few common actions up top, the rest grouped in submenus

export const hint = (combo: string) => keyLabel(combo);
export const ms = (t: number) => Math.round(t * 1000) / 1000;

export function openInspector(tab: InspectorTab) {
  setInspectorTab(tab);
  if (!store.settings.ui.propsOpen) toggleProps();
  else if (session) scheduleProps(session);
}

/** Cut / copy / paste / duplicate / delete for `ids` (or the selection), greyed out when they don't apply. */
export function editMenu(at: number, ids?: string[]): MenuItem {
  const { overlays, tracks } = selectedItems(ids);
  const any = overlays.length + tracks.length > 0;
  const removable = removableIds(ids).length > 0;
  return {
    label: "Edit",
    icon: Copy,
    items: [
      {
        label: "Cut",
        icon: ScissorsLineDashed,
        hint: hint("ctrl+x"),
        disabled: !removable,
        run: () => copySelection(true, ids),
      },
      {
        label: "Copy",
        icon: Copy,
        hint: hint("ctrl+c"),
        disabled: !any,
        run: () => copySelection(false, ids),
      },
      pasteItem(at),
      {
        label: "Duplicate",
        icon: CopyPlus,
        hint: hint("ctrl+d"),
        disabled: !any,
        run: () => duplicate(ids),
      },
    ],
  };
}

export const pasteItem = (at: number): MenuItem => ({
  label: "Paste here",
  icon: ClipboardPaste,
  hint: hint("ctrl+v"),
  disabled: !clipboard,
  run: () => paste(at),
});

export const splitItem = (t: number): MenuItem => ({
  label: "Split here",
  icon: Scissors,
  hint: hint("s"),
  run: () => session?.edit.split(t),
});

export function partMenu(t: number): MenuItem {
  const e = session!.edit;
  const i = e.indexAt(t);
  const seg = e.segs[i];
  return {
    label: "Part",
    icon: Crop,
    items: [
      seg.on &&
        e.segs.length > 1 && {
          label: "Keep only this part",
          icon: Crop,
          run: () => e.keepOnly(seg.start, seg.end),
        },
      seg.on && {
        label: "Trim start to here",
        icon: ArrowLeftToLine,
        hint: hint("q"),
        run: () => e.trimBefore(t),
      },
      seg.on && {
        label: "Trim end from here",
        icon: ArrowRightToLine,
        hint: hint("w"),
        run: () => e.trimAfter(t),
      },
      e.segs.some(s => !s.on) && {
        label: "Restore all removed parts",
        icon: ListRestart,
        run: () => e.setRange(0, e.duration, true),
      },
    ],
  };
}

export const removeItem = (t: number): MenuItem => {
  const e = session!.edit;
  const i = e.indexAt(t);
  const on = e.segs[i].on;
  return {
    label: on ? "Remove this part" : "Restore this part",
    icon: on ? Trash : Undo2,
    hint: hint("delete"),
    run: () => e.toggle(i),
  };
};

export function marksMenu(t: number): MenuItem {
  const e = session!.edit;
  return {
    label: "Marks",
    icon: MarkIn,
    items: [
      {
        label: "Mark in here",
        icon: MarkIn,
        hint: hint("i"),
        run: () => e.setMark("in", t),
      },
      {
        label: "Mark out here",
        icon: MarkOut,
        hint: hint("o"),
        run: () => e.setMark("out", t),
      },
      !!e.range() && "sep",
      !!e.range() && {
        label: "Keep only marked range",
        icon: Crop,
        hint: hint("t"),
        run: keepRange,
      },
      !!e.range() && {
        label: "Clear marks",
        icon: X,
        hint: hint("alt+x"),
        run: () => e.clearMarks(),
      },
    ],
  };
}

export const addMenu = (t: number): MenuItem => ({
  label: "Add",
  icon: Plus,
  items: [
    {
      label: "Image here…",
      icon: ImagePlus,
      hint: hint("ctrl+shift+i"),
      run: () => addImage(t),
    },
    {
      label: "From the image library…",
      icon: ImageIcon,
      run: () => addFromLibrary(t),
    },
    {
      label: "Audio here…",
      icon: FileMusic,
      hint: hint("ctrl+shift+a"),
      run: () => addAudioTrack(t),
    },
    "sep",
    pasteItem(t),
  ],
});

export function viewMenu(): MenuItem {
  const ui = store.settings.ui;
  return {
    label: "View",
    icon: FoldHorizontal,
    items: [
      {
        label: "Fit whole clip",
        icon: FoldHorizontal,
        hint: hint("\\"),
        run: () => session?.tl.fit(),
      },
      {
        label: "Zoom in",
        icon: ZoomIn,
        hint: hint("+"),
        run: () => session?.tl.zoomBy(1.5),
      },
      {
        label: "Zoom out",
        icon: ZoomOut,
        hint: hint("-"),
        run: () => session?.tl.zoomBy(1 / 1.5),
      },
      "sep",
      {
        label: "Collapse removed parts",
        icon: ChevronsRightLeft,
        hint: hint("h"),
        checked: ui.collapseRemoved,
        run: toggleCollapseRemoved,
      },
      {
        label: "Linked selection",
        icon: Link2,
        hint: hint("ctrl+shift+l"),
        checked: ui.linkedSelection,
        run: toggleLinkedSelection,
      },
    ],
  };
}

/** Frame, rotation and file info: things about the whole clip. */
export function clipMenu(t: number): MenuItem {
  const e = session!.edit;
  return {
    label: "Clip",
    icon: Film,
    items: [
      {
        label: "Save frame as PNG",
        icon: Camera,
        hint: hint("ctrl+shift+s"),
        run: () => {
          seek(t);
          saveFrame();
        },
      },
      { label: "Copy timecode", icon: Clock, run: () => copyTimecode(t) },
      "sep",
      {
        label: "Rotate",
        icon: RotateCw,
        items: ([0, 90, 180, 270] as Look["rotate"][]).map(r => ({
          label: `${r}°`,
          checked: e.look.rotate === r,
          run: () => e.setLook({ rotate: r }),
        })),
      },
      {
        label: "Flip horizontally",
        icon: MoveHorizontal,
        checked: e.look.flip,
        run: () => e.setLook({ flip: !e.look.flip }),
      },
      "sep",
      { label: "Clip info", icon: Info, hint: hint("ctrl+i"), run: showInfo },
      {
        label: "Edit metadata…",
        icon: Tags,
        hint: hint("ctrl+shift+m"),
        run: showMetadata,
      },
    ],
  };
}

export const inspectorItem = (tab: InspectorTab): MenuItem => ({
  label: "Show in Inspector",
  icon: PanelRight,
  run: () => openInspector(tab),
});

export function videoItems(t: number, header: boolean): MenuItem[] {
  const s = session!;
  const e = s.edit;
  const i = e.indexAt(t);
  const seg = e.segs[i];
  return [
    {
      section: header
        ? "V1 · Video · at the playhead"
        : `Part ${i + 1} of ${e.segs.length} · ${fmt(seg.start, false)}–${fmt(seg.end, false)}${seg.on ? "" : " · removed"}`,
    },
    {
      label: "Play from here",
      icon: Play,
      run: () => {
        seek(seg.on ? t : (e.nextKept(t) ?? t));
        if (s.video.paused) togglePlay();
      },
    },
    splitItem(t),
    removeItem(t),
    partMenu(t),
    marksMenu(t),
    "sep",
    addMenu(t),
    clipMenu(t),
    "sep",
    inspectorItem("video"),
  ];
}

export function trackItems(
  t: Track,
  at: number,
  onClip: boolean,
  header: boolean
): MenuItem[] {
  const e = session!.edit;
  const i = e.tracks.indexOf(t);
  const gain = (db: number) =>
    e.updateTrack(t.id, { gainDb: Math.round(clamp(db, -30, 12) * 10) / 10 });
  return [
    { section: `A${i + 1} · ${t.name}` },
    {
      label: "Mute",
      icon: VolumeX,
      checked: t.muted,
      run: () => e.updateTrack(t.id, { muted: !t.muted }),
    },
    {
      label: "Solo",
      icon: Headphones,
      checked: t.solo,
      run: () => e.updateTrack(t.id, { solo: !t.solo }),
    },
    {
      label: "Volume",
      icon: Volume2,
      hint: fmtDb(t.gainDb),
      items: [
        {
          label: "Reset to 0 dB",
          disabled: t.gainDb === 0,
          run: () => gain(0),
        },
        { label: "Louder · +3 dB", run: () => gain(t.gainDb + 3) },
        { label: "Quieter · −3 dB", run: () => gain(t.gainDb - 3) },
        { label: "Much quieter · −10 dB", run: () => gain(t.gainDb - 10) },
      ],
    },
    "sep",
    editMenu(at, [t.id]),
    {
      label: "Track",
      icon: FileMusic,
      items: [
        {
          label: "Linked to the video",
          icon: Link2,
          checked: t.linked,
          run: () => e.updateTrack(t.id, { linked: !t.linked }),
        },
        t.kind === "file" && {
          label: onClip || header ? "Start at playhead" : "Move start here",
          icon: ArrowLeftToLine,
          run: () =>
            e.updateTrack(t.id, { offset: ms(onClip || header ? time() : at) }),
        },
        "sep",
        {
          label: "Move up",
          icon: ArrowUp,
          disabled: i === 0,
          run: () => e.moveTrack(i, i - 1),
        },
        {
          label: "Move down",
          icon: ArrowDown,
          disabled: i === e.tracks.length - 1,
          run: () => e.moveTrack(i, i + 1),
        },
        t.kind === "file" && "sep",
        t.kind === "file" && {
          label: "Show file in folder",
          icon: FolderOpen,
          run: () => api.reveal(t.path),
        },
      ],
    },
    // cuts go through every track, so splitting from here works too
    !header && splitItem(at),
    t.kind === "file" && {
      label: "Delete track",
      icon: Trash,
      danger: true,
      run: () => deleteSelection([t.id]),
    },
    "sep",
    inspectorItem("audio"),
  ];
}

export function imageItems(
  o: Overlay,
  at: number,
  onClip: boolean
): MenuItem[] {
  const s = session!;
  const e = s.edit;
  const i = e.overlays.indexOf(o);
  const now = time();
  const [fw, fh] = frameSize(s);
  const img = getImage(o.path);
  // image aspect over frame aspect: 1 means the image has the frame's shape
  const fit = img.naturalWidth
    ? img.naturalWidth / img.naturalHeight / (fw / fh)
    : 1;
  const set = (patch: Partial<Overlay>) => e.updateOverlay(o.id, patch);
  return [
    { section: `V${i + 2} · ${o.name}` },
    editMenu(at, [o.id]),
    {
      label: "Timing",
      icon: Clock,
      items: [
        {
          label: onClip ? "Start at playhead" : "Move here",
          icon: ArrowLeftToLine,
          run: () => set({ start: ms(onClip ? now : at) }),
        },
        {
          label: "End at playhead",
          icon: ArrowRightToLine,
          disabled: now <= o.start + 0.05,
          run: () => set({ duration: ms(now - o.start) }),
        },
        {
          label: "Show for the whole clip",
          icon: MoveHorizontal,
          run: () => set({ start: 0, duration: s.probe.duration }),
        },
      ],
    },
    {
      label: "Size & position",
      icon: Scan,
      items: [
        {
          label: "Center",
          icon: Crosshair,
          run: () => set({ x: 0.5, y: 0.5 }),
        },
        {
          label: "Fit to frame",
          icon: Scan,
          run: () => set({ x: 0.5, y: 0.5, scale: ms(Math.min(1, fit)) }),
        },
        {
          label: "Fill frame",
          icon: Maximize,
          run: () => set({ x: 0.5, y: 0.5, scale: ms(Math.max(1, fit)) }),
        },
        "sep",
        {
          label: "Opacity",
          hint: `${Math.round(o.opacity * 100)}%`,
          items: [1, 0.75, 0.5, 0.25].map(v => ({
            label: `${v * 100}%`,
            checked: Math.abs(o.opacity - v) < 0.005,
            run: () => set({ opacity: v }),
          })),
        },
      ],
    },
    {
      label: "Arrange",
      icon: BringToFront,
      items: [
        {
          label: "Bring forward",
          icon: BringToFront,
          disabled: i === e.overlays.length - 1,
          run: () => e.restackOverlay(o.id, 1),
        },
        {
          label: "Send backward",
          icon: SendToBack,
          disabled: i === 0,
          run: () => e.restackOverlay(o.id, -1),
        },
      ],
    },
    {
      label: "File",
      icon: FolderOpen,
      items: [
        { label: "Replace image…", icon: Replace, run: () => replaceImage(o) },
        {
          label: "Show in folder",
          icon: FolderOpen,
          run: () => api.reveal(o.path),
        },
      ],
    },
    {
      label: "Delete image",
      icon: Trash,
      hint: hint("delete"),
      danger: true,
      run: () => deleteSelection([o.id]),
    },
    "sep",
    inspectorItem("image"),
  ];
}

export function timelineMenu(target: Target, ev: MouseEvent) {
  const s = session;
  if (!s) return;
  const e = s.edit;
  const t = target.t;
  const track = target.id ? e.track(target.id) : undefined;
  const overlay = target.id ? e.overlay(target.id) : undefined;
  let items: MenuItem[];
  if (overlay) items = imageItems(overlay, t, !!target.onClip);
  else if (track)
    items = trackItems(track, t, !!target.onClip, !!target.header);
  else if (target.area === "video") items = videoItems(t, !!target.header);
  else if (target.area === "ruler")
    items = [
      { label: "Go here", icon: Play, run: () => seek(t) },
      splitItem(t),
      marksMenu(t),
      "sep",
      viewMenu(),
    ];
  else
    items = [
      {
        label: "Add image here…",
        icon: ImagePlus,
        hint: hint("ctrl+shift+i"),
        run: () => addImage(t),
      },
      {
        label: "From the image library…",
        icon: ImageIcon,
        run: () => addFromLibrary(t),
      },
      {
        label: "Add audio here…",
        icon: FileMusic,
        hint: hint("ctrl+shift+a"),
        run: () => addAudioTrack(t),
      },
      pasteItem(t),
      "sep",
      splitItem(t),
      marksMenu(t),
      "sep",
      {
        label: "Undo",
        icon: Undo2,
        hint: hint("ctrl+z"),
        disabled: !e.canUndo,
        run: () => e.undo(),
      },
      {
        label: "Redo",
        icon: Redo2,
        hint: hint("ctrl+shift+z"),
        disabled: !e.canRedo,
        run: () => e.redo(),
      },
      {
        label: "Select all",
        icon: SquareDashedMousePointer,
        hint: hint("ctrl+a"),
        run: selectAll,
      },
      "sep",
      viewMenu(),
    ];
  menu({ x: ev.clientX, y: ev.clientY }, items);
}

/** Right-click on the preview (not on an image). */
export function stageMenu(ev: MouseEvent) {
  const s = session;
  if (!s) return;
  const t = s.video.currentTime;
  menu({ x: ev.clientX, y: ev.clientY }, [
    {
      label: s.video.paused ? "Play" : "Pause",
      icon: s.video.paused ? Play : Pause,
      hint: hint("space"),
      run: togglePlay,
    },
    {
      label: "Add image…",
      icon: ImagePlus,
      hint: hint("ctrl+shift+i"),
      run: () => addImage(t),
    },
    {
      label: "From the image library…",
      icon: ImageIcon,
      run: () => addFromLibrary(t),
    },
    {
      label: "Paste",
      icon: ClipboardPaste,
      hint: hint("ctrl+v"),
      disabled: !clipboard,
      run: () => paste(t),
    },
    "sep",
    clipMenu(t),
  ]);
}
