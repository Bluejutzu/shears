export type Seg = { start: number; end: number; on: boolean };
type Snap = { segs: Seg[]; inPt: number | null; outPt: number | null };

const EPS = 1e-6;

/** The cut list: segments covering the whole source, each kept or removed. */
export class Edit {
  segs: Seg[];
  inPt: number | null = null;
  outPt: number | null = null;
  sel = -1;
  onChange = () => {};
  private past: Snap[] = [];
  private future: Snap[] = [];

  constructor(
    public duration: number,
    public minLen: number,
  ) {
    this.segs = [{ start: 0, end: duration, on: true }];
  }

  private snap(): Snap {
    return { segs: this.segs.map((s) => ({ ...s })), inPt: this.inPt, outPt: this.outPt };
  }

  private restore(s: Snap) {
    this.segs = s.segs;
    this.inPt = s.inPt;
    this.outPt = s.outPt;
    this.sel = Math.min(this.sel, this.segs.length - 1);
  }

  /** Save an undo step before a manual change (like dragging a cut). */
  checkpoint() {
    this.past.push(this.snap());
    if (this.past.length > 300) this.past.shift();
    this.future = [];
  }

  private change(fn: () => boolean) {
    const before = this.snap();
    if (!fn()) {
      this.restore(before);
      return false;
    }
    this.past.push(before);
    if (this.past.length > 300) this.past.shift();
    this.future = [];
    this.onChange();
    return true;
  }

  undo() {
    const s = this.past.pop();
    if (!s) return false;
    this.future.push(this.snap());
    this.restore(s);
    this.onChange();
    return true;
  }

  redo() {
    const s = this.future.pop();
    if (!s) return false;
    this.past.push(this.snap());
    this.restore(s);
    this.onChange();
    return true;
  }

  indexAt(t: number) {
    const i = this.segs.findIndex((s) => t < s.end - EPS);
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
        if (t != null && this.outPt != null && this.outPt <= t) this.outPt = null;
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

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Marked range, filling in a missing side with the clip start/end. */
  range(): [number, number] | null {
    if (this.inPt == null && this.outPt == null) return null;
    return [this.inPt ?? 0, this.outPt ?? this.duration];
  }

  /** Cut positions (excludes 0 and the end). */
  cuts() {
    return this.segs.slice(1).map((s) => s.start);
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

  edited() {
    return this.segs.some((s) => !s.on);
  }

  /** Start of the next kept segment at or after t. */
  nextKept(t: number) {
    return this.segs.find((s) => s.on && s.end > t + EPS)?.start ?? null;
  }

  isKept(t: number) {
    return this.segs[this.indexAt(t)].on;
  }
}
