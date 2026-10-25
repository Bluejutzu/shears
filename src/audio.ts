import type { Track } from "./edit";
import { dbToGain } from "./ui";

type Voice = { el: HTMLAudioElement; gain: GainNode };

// how far a track may drift from the video before it gets snapped back
const MAX_DRIFT = 0.12;

/**
 * Plays every audio track as its own element routed through Web Audio, kept in sync with the
 * (muted) video. That's what makes per-track volume, mute, solo and boosting past 100% possible.
 */
export class AudioEngine {
  private ctx = new AudioContext();
  private master = this.ctx.createGain();
  private voices = new Map<string, Voice>();
  private masterDb = 0;
  private masterMuted = false;

  constructor(private video: HTMLVideoElement) {
    this.master.connect(this.ctx.destination);
  }

  get active() {
    return this.voices.size > 0;
  }

  has(id: string) {
    return this.voices.has(id);
  }

  attach(id: string, url: string) {
    if (this.voices.has(id)) return;
    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.src = url;
    const gain = this.ctx.createGain();
    this.ctx.createMediaElementSource(el).connect(gain).connect(this.master);
    this.voices.set(id, { el, gain });
  }

  detach(id: string) {
    const v = this.voices.get(id);
    if (!v) return;
    v.el.pause();
    v.el.removeAttribute("src");
    v.el.load();
    v.gain.disconnect();
    this.voices.delete(id);
  }

  /** Drop voices for tracks that no longer exist (e.g. after undoing an added track). */
  prune(ids: Set<string>) {
    for (const id of [...this.voices.keys()]) if (!ids.has(id)) this.detach(id);
  }

  setMaster(db: number, muted: boolean) {
    this.masterDb = db;
    this.masterMuted = muted;
    const g = muted || db <= -40 ? 0 : dbToGain(db);
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
    // without separate tracks (no ffmpeg) the video plays its own audio, which can't go past 100%
    this.video.volume = Math.min(1, g);
  }

  applyGains(tracks: Track[]) {
    const solo = tracks.some(t => t.solo);
    for (const t of tracks) {
      const v = this.voices.get(t.id);
      if (!v) continue;
      const g = t.muted || (solo && !t.solo) ? 0 : dbToGain(t.gainDb);
      v.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.015);
    }
    this.video.muted = this.active || this.masterMuted;
    this.setMaster(this.masterDb, this.masterMuted);
  }

  resume() {
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  /** Called every frame: start, stop and re-align track playback to follow the video. */
  sync(tracks: Track[]) {
    const video = this.video;
    const playing = !video.paused && !video.seeking;
    for (const t of tracks) {
      const v = this.voices.get(t.id);
      if (!v) continue;
      const el = v.el;
      const target = video.currentTime - (t.kind === "file" ? t.offset : 0);
      const inRange =
        target >= 0 && (!isFinite(el.duration) || target < el.duration - 0.03);
      if (!playing || !inRange) {
        if (!el.paused) el.pause();
        continue;
      }
      if (el.playbackRate !== video.playbackRate)
        el.playbackRate = video.playbackRate;
      if (el.paused) {
        el.currentTime = target;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - target) > MAX_DRIFT) {
        el.currentTime = target;
      }
    }
  }

  destroy() {
    for (const id of [...this.voices.keys()]) this.detach(id);
    this.ctx.close().catch(() => {});
  }
}
