import type { VoiceCursorFrame } from "./cursor-style.ts";

export const CURSOR_FRAME_INTERVAL_MS = 1_000 / 16;
const attackMs = 45;
const releaseMs = 80;
const heightHysteresis = 0.15;

// Fast attack follows speech; slower release damps quiet gaps. At 16 Hz, a full
// seven-bin sweep finishes in roughly 440 ms without skipping heights.
// Color advances on the same presentation ticks, never on host key repeats.

export class CursorAnimation {
  private cached: VoiceCursorFrame | undefined;
  private lastTickMs: number | undefined;
  private smoothedLevel = 0;
  private height = 0;

  update(input: VoiceCursorFrame): VoiceCursorFrame {
    const steady = input.state === "transcribing" || input.reducedMotion;
    const modeChanged = this.cached?.state !== input.state
      || this.cached.reducedMotion !== input.reducedMotion;

    if (steady) {
      this.lastTickMs = undefined;
      this.smoothedLevel = 0;
      this.height = 0;
      if (modeChanged || this.cached?.color !== input.color) {
        this.cached = {
          ...input,
          level: input.state === "transcribing" ? 3 / 7 : 5 / 7,
          nowMs: 0,
        };
      }
      return this.cached!;
    }
    const nowMs = Number.isFinite(input.nowMs) ? Math.max(0, input.nowMs) : undefined;
    if (!this.cached || modeChanged) {
      this.smoothedLevel = Number.isNaN(input.level) ? 0 : Math.max(0, Math.min(1, input.level));
      this.height = Math.round(this.smoothedLevel * 7);
      this.lastTickMs = nowMs;
      this.cached = {
        ...input,
        level: this.height / 7,
        nowMs: nowMs ?? 0,
      };
      return this.cached;
    }

    if (this.cached.color !== input.color) this.cached = { ...this.cached, color: input.color };
    if (nowMs === undefined) return this.cached;
    if (this.lastTickMs === undefined || nowMs < this.lastTickMs) {
      this.lastTickMs = nowMs;
      return this.cached;
    }

    const elapsedMs = nowMs - this.lastTickMs;
    if (elapsedMs + 0.001 < CURSOR_FRAME_INTERVAL_MS) return this.cached;
    // Keep the presentation phase under irregular polling without replaying missed frames.
    this.lastTickMs += Math.floor((elapsedMs + 0.001) / CURSOR_FRAME_INTERVAL_MS) * CURSOR_FRAME_INTERVAL_MS;
    const target = Number.isNaN(input.level) ? 0 : Math.max(0, Math.min(1, input.level));
    const timeConstantMs = target > this.smoothedLevel ? attackMs : releaseMs;
    // A stalled host gets one normal interpolation step, never a catch-up flash.
    const interpolation = -Math.expm1(-Math.min(elapsedMs, CURSOR_FRAME_INTERVAL_MS) / timeConstantMs);
    this.smoothedLevel += (target - this.smoothedLevel) * interpolation;
    const position = this.smoothedLevel * 7;
    // A 0.15-bin dead band around each rounding boundary suppresses adjacent-bin chatter.
    if (this.height < 7 && position > this.height + 0.5 + heightHysteresis) this.height++;
    else if (this.height > 0 && position < this.height - 0.5 - heightHysteresis) this.height--;

    const level = this.height / 7;
    const colorTimeMs = this.lastTickMs;
    if (this.cached.level !== level || this.cached.nowMs !== colorTimeMs) {
      this.cached = { ...this.cached, level, nowMs: colorTimeMs };
    }
    return this.cached;
  }

  reset(): void {
    this.cached = undefined;
    this.lastTickMs = undefined;
    this.smoothedLevel = 0;
    this.height = 0;
  }
}
