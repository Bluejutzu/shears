import type { MetaEdit } from "../shared/api";

export type Seg = { start: number; end: number; on: boolean };

export type Track = {
  id: string;
  /** "source" = an audio track inside the video, "file" = a separate file added on top */
  kind: "source" | "file";
  name: string;
  path: string;
  /** audio stream index inside `path` */
  index: number;
  codec: string;
  /** where a file track starts on the source timeline, in seconds */
  offset: number;
  duration: number;
  gainDb: number;
  muted: boolean;
  solo: boolean;
  /** linked tracks get selected together with the video, like linked clips in Resolve */
  linked: boolean;
};

/** An image laid over the video for a while. */
export type Overlay = {
  id: string;
  name: string;
  path: string;
  /** source timeline seconds, like file tracks */
  start: number;
  duration: number;
  /** center of the image, as a fraction of the frame */
  x: number;
  y: number;
  /** image width as a fraction of the frame width */
  scale: number;
  opacity: number;
};

export type Look = { rotate: 0 | 90 | 180 | 270; flip: boolean };

/** Tag changes for the file: a string sets a tag, null removes it; strip drops them all on export. */
export type Meta = { tags: Record<string, string | null>; strip: boolean };

/** What gets remembered per clip and restored with undo. */
export type Doc = {
  segs: Seg[];
  inPt: number | null;
  outPt: number | null;
  tracks: Track[];
  look: Look;
  /** bottom to top */
  overlays: Overlay[];
  meta?: Meta;
};

const EPS = 1e-6;

/** The cut list and track settings for one clip. Segments cover the whole source, each kept or removed. */
export class Edit {
  segs: Seg[];
  inPt: number | null = null;
  outPt: number | null = null;
  tracks: Track[] = [];
  look: Look = { rotate: 0, flip: false };
  overlays: Overlay[] = [];
  meta: Meta = { tags: {}, strip: false };
  sel = -1;
  /** selected lanes: track ids and/or "video" */
  selected: string[] = [];
  onChange = () => {};
  private past: Doc[] = [];
  private future: Doc[] = [];

  constructor(
    public duration: number,
    public minLen: number
  ) {
    this.segs = [{ start: 0, end: duration, on: true }];
  }

  doc(): Doc {
    return {
      segs: this.segs.map(s => ({ ...s })),
      inPt: this.inPt,
      outPt: this.outPt,
      tracks: this.tracks.map(t => ({ ...t })),
      look: { ...this.look },
      overlays: this.overlays.map(o => ({ ...o })),
      meta: { tags: { ...this.meta.tags }, strip: this.meta.strip },
    };
  }

  load(d: Doc) {
    this.segs = d.segs;
    this.inPt = d.inPt;
    this.outPt = d.outPt;
    this.tracks = d.tracks;
    this.look = d.look;
    // edits saved before overlays existed don't have them
    this.overlays = d.overlays ?? [];
    this.meta = d.meta ?? { tags: {}, strip: false };
    this.sel = Math.min(this.sel, this.segs.length - 1);
    this.selected = this.selected.filter(
      id => id === "video" || !!this.track(id) || !!this.overlay(id)
    );
  }

  /** Save an undo step before a manual change (like dragging a cut or a volume line). */
  checkpoint() {
    this.past.push(this.doc());
    if (this.past.length > 300) this.past.shift();
    this.future = [];
  }

  private change(fn: () => boolean) {
    const before = this.doc();
    if (!fn()) {
      this.load(before);
      return false;
    }
    this.past.push(before);
    if (this.past.length > 300) this.past.shift();
    this.future = [];
    this.onChange();
    return true;
  }

  undo() {
    const d = this.past.pop();
    if (!d) return false;
    this.future.push(this.doc());
    this.load(d);
    this.onChange();
    return true;
  }

  redo() {
    const d = this.future.pop();
    if (!d) return false;
    this.past.push(this.doc());
    this.load(d);
    this.onChange();
    return true;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Untouched clip: nothing worth remembering. */
  pristine() {
    return (
      this.segs.length === 1 &&
      this.segs[0].on &&
      this.inPt == null &&
      this.outPt == null &&
      this.look.rotate === 0 &&
      !this.look.flip &&
      !this.overlays.length &&
      !this.meta.strip &&
      !Object.keys(this.meta.tags).length &&
      this.tracks.every(
        (t, i) =>
          t.kind === "source" &&
          t.index === i &&
          t.linked &&
          t.gainDb === 0 &&
          !t.muted &&
          !t.solo
      )
    );
  }

  // ---- cuts

  indexAt(t: number) {
    const i = this.segs.findIndex(s => t < s.end - EPS);
    return i < 0 ? this.segs.length - 1 : i;
  }

  /** Make sure there's a cut at t (snapping to nearby cuts) and return the index of the segment starting there. */
  private cut(t: number) {
    if (t <= this.minLen) return 0;
    if (t >= this.duration - this.minLen) return this.segs.length;
    const i = this.indexAt(t);
    const s = this.segs[i];
    if (t - s.start < this.minLen) return i;
    if (s.end - t < this.minLen) return i + 1;
    this.segs.splice(i, 1, { ...s, end: t }, { ...s, start: t });
    return i + 1;
  }

  split(t: number) {
    return this.change(() => {
      const n = this.segs.length;
      this.cut(t);
      return this.segs.length !== n;
    });
  }

  setRange(a: number, b: number, on: boolean) {
    return this.change(() => {
      const i = this.cut(a);
      const j = this.cut(b);
      let changed = false;
      for (let k = i; k < j; k++) {
        if (this.segs[k].on !== on) changed = true;
        this.segs[k].on = on;
      }
      this.sel = -1;
      return changed;
    });
  }

  toggle(i: number) {
    return this.change(() => {
      this.segs[i].on = !this.segs[i].on;
      return true;
    });
  }

  /** Q: drop everything from the start of the current segment up to t. */
  trimBefore(t: number) {
    return this.setRange(this.segs[this.indexAt(t)].start, t, false);
  }

  /** W: drop everything from t to the end of the current segment. */
  trimAfter(t: number) {
    return this.setRange(t, this.segs[this.indexAt(t)].end, false);
  }

  keepOnly(a: number, b: number) {
    return this.change(() => {
      const i = this.cut(a);
      const j = this.cut(b);
      let changed = false;
      this.segs.forEach((s, k) => {
        if ((k < i || k >= j) && s.on) {
          s.on = false;
          changed = true;
        }
      });
      this.sel = -1;
      return changed;
    });
  }

  setMark(which: "in" | "out", t: number | null) {
    return this.change(() => {
      if (which === "in") {
        this.inPt = t;
        if (t != null && this.outPt != null && this.outPt <= t)
          this.outPt = null;
      } else {
        this.outPt = t;
        if (t != null && this.inPt != null && this.inPt >= t) this.inPt = null;
      }
      return true;
    });
  }

  clearMarks() {
    return this.change(() => {
      const had = this.inPt != null || this.outPt != null;
      this.inPt = this.outPt = null;
      return had;
    });
  }

  /** Marked range, filling in a missing side with the clip start/end. */
  range(): [number, number] | null {
    if (this.inPt == null && this.outPt == null) return null;
    return [this.inPt ?? 0, this.outPt ?? this.duration];
  }

  /** Cut positions (excludes 0 and the end). */
  cuts() {
    return this.segs.slice(1).map(s => s.start);
  }

  moveCut(k: number, t: number) {
    const a = this.segs[k - 1];
    const b = this.segs[k];
    t = Math.min(Math.max(t, a.start + this.minLen), b.end - this.minLen);
    a.end = b.start = t;
    this.onChange();
    return t;
  }

  /** Merged ranges that end up in the export. */
  kept(): [number, number][] {
    const out: [number, number][] = [];
    for (const s of this.segs) {
      if (!s.on) continue;
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - s.start) < EPS) last[1] = s.end;
      else out.push([s.start, s.end]);
    }
    return out;
  }

  outDuration() {
    return this.kept().reduce((sum, [a, b]) => sum + b - a, 0);
  }

  /** Start of the next kept segment at or after t. */
  nextKept(t: number) {
    return this.segs.find(s => s.on && s.end > t + EPS)?.start ?? null;
  }

  isKept(t: number) {
    return this.segs[this.indexAt(t)].on;
  }

  // ---- tracks and look

  track(id: string) {
    return this.tracks.find(t => t.id === id);
  }

  updateTrack(id: string, patch: Partial<Track>) {
    return this.change(() => {
      const t = this.track(id);
      if (!t) return false;
      Object.assign(t, patch);
      return true;
    });
  }

  addTrack(track: Track) {
    return this.change(() => {
      this.tracks.push(track);
      this.selected = [track.id];
      return true;
    });
  }

  moveTrack(from: number, to: number) {
    return this.change(() => {
      if (from === to || !this.tracks[from]) return false;
      const [t] = this.tracks.splice(from, 1);
      this.tracks.splice(Math.min(Math.max(to, 0), this.tracks.length), 0, t);
      return true;
    });
  }

  // ---- selection

  /** Everything that gets selected along with a lane: the video and its linked tracks, or just the lane. */
  group(id: string) {
    const t = this.track(id);
    if (id !== "video" && !t?.linked) return [id];
    return ["video", ...this.tracks.filter(x => x.linked).map(x => x.id)];
  }

  /** Click on a lane. `linked` follows the linked-selection toggle, `add` is ctrl-click. */
  selectLane(id: string, linked: boolean, add = false) {
    const ids = linked ? this.group(id) : [id];
    if (add) {
      const all = ids.every(x => this.selected.includes(x));
      this.selected = all
        ? this.selected.filter(x => !ids.includes(x))
        : [...new Set([...this.selected, ...ids])];
    } else {
      this.selected = ids;
    }
  }

  isSelected(id: string) {
    return this.selected.includes(id);
  }

  removeTrack(id: string) {
    return this.change(() => {
      const n = this.tracks.length;
      this.tracks = this.tracks.filter(t => t.id !== id);
      return this.tracks.length !== n;
    });
  }

  // ---- overlays

  overlay(id: string) {
    return this.overlays.find(o => o.id === id);
  }

  /** Add overlays and/or file tracks in one undo step and select them (adding, pasting). */
  addItems(overlays: Overlay[], tracks: Track[]) {
    return this.change(() => {
      this.overlays.push(...overlays);
      this.tracks.push(...tracks);
      this.selected = [...overlays, ...tracks].map(x => x.id);
      return overlays.length + tracks.length > 0;
    });
  }

  updateOverlay(id: string, patch: Partial<Overlay>) {
    return this.change(() => {
      const o = this.overlay(id);
      if (!o) return false;
      Object.assign(o, patch);
      return true;
    });
  }

  /** Move an overlay up (toward the front) or down the stack. */
  restackOverlay(id: string, dir: 1 | -1) {
    return this.change(() => {
      const i = this.overlays.findIndex(o => o.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= this.overlays.length) return false;
      [this.overlays[i], this.overlays[j]] = [
        this.overlays[j],
        this.overlays[i],
      ];
      return true;
    });
  }

  /** Delete overlays and/or added file tracks in one undo step. */
  removeItems(ids: string[]) {
    return this.change(() => {
      const n = this.overlays.length + this.tracks.length;
      this.overlays = this.overlays.filter(o => !ids.includes(o.id));
      this.tracks = this.tracks.filter(t => !ids.includes(t.id));
      this.selected = this.selected.filter(id => !ids.includes(id));
      return this.overlays.length + this.tracks.length !== n;
    });
  }

  // ---- metadata

  /** Change tags: a string sets one, null removes it, undefined goes back to the file's own. */
  setTags(patch: Record<string, string | null | undefined>) {
    return this.change(() => {
      const tags = { ...this.meta.tags };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete tags[k];
        else tags[k] = v;
      }
      const changed = JSON.stringify(tags) !== JSON.stringify(this.meta.tags);
      this.meta = { ...this.meta, tags };
      return changed;
    });
  }

  setStrip(strip: boolean) {
    return this.change(() => {
      if (this.meta.strip === strip) return false;
      this.meta = { ...this.meta, strip };
      return true;
    });
  }

  /** The tag changes in the shape the backend takes. */
  metaEdit(): MetaEdit {
    return { strip: this.meta.strip, tags: Object.entries(this.meta.tags) };
  }

  /** Forget all tag changes, e.g. once they've been written into the file. */
  clearTags() {
    return this.change(() => {
      const had = Object.keys(this.meta.tags).length > 0;
      this.meta = { ...this.meta, tags: {} };
      return had;
    });
  }

  setLook(patch: Partial<Look>) {
    return this.change(() => {
      Object.assign(this.look, patch);
      return true;
    });
  }
}
