import type { VoiceCursorFrame } from "./cursor-style.ts";

export const CURSOR_FRAME_INTERVAL_MS = 1_000 / 60;
const colorIntervalMs = 1_000 / 15;

export class CursorAnimation {
  private cached: VoiceCursorFrame | undefined;
  private lastTickMs: number | undefined;
  private lastNowMs: number | undefined;
  private recordingStartMs: number | undefined;

  update(input: VoiceCursorFrame): VoiceCursorFrame {
    const nowMs = Number.isFinite(input.nowMs) ? Math.max(0, input.nowMs) : undefined;
    const stateChanged = this.cached?.state !== input.state;
    const modeChanged = stateChanged || this.cached?.reducedMotion !== input.reducedMotion;
    if (stateChanged) {
      this.recordingStartMs = input.state === "recording" ? nowMs : undefined;
      this.lastTickMs = undefined;
      this.lastNowMs = undefined;
    }
    if (input.state === "recording" && this.recordingStartMs === undefined && nowMs !== undefined) {
      this.recordingStartMs = nowMs;
    }

    if (input.state === "transcribing" || input.reducedMotion) {
      this.lastTickMs = undefined;
      if (modeChanged || this.cached?.color !== input.color) {
        this.cached = {
          ...input,
          level: input.state === "transcribing" ? 3 / 7 : 5 / 7,
          nowMs: 0,
        };
      }
      return this.cached!;
    }

    const validClock = nowMs !== undefined && (this.lastNowMs === undefined || nowMs >= this.lastNowMs);
    if (validClock) this.lastNowMs = nowMs;
    const tick = validClock && (this.lastTickMs === undefined
      || nowMs - this.lastTickMs + 0.001 >= CURSOR_FRAME_INTERVAL_MS);
    let level = this.cached?.level ?? 0;
    if (modeChanged || tick) {
      const strength = Number.isNaN(input.level) ? 0 : Math.max(0, Math.min(1, input.level));
      level = (Math.max(1, Math.round(strength * 8)) - 1) / 7;
      if (validClock) {
        this.lastTickMs = this.lastTickMs === undefined ? nowMs
          : this.lastTickMs + Math.floor((nowMs - this.lastTickMs + 0.001) / CURSOR_FRAME_INTERVAL_MS) * CURSOR_FRAME_INTERVAL_MS;
      }
    }
    let colorTimeMs = this.cached?.nowMs ?? 0;
    if (modeChanged) colorTimeMs = 0;
    // Silence holds the painted frame, but not the session-relative hue clock.
    if (validClock && input.active && input.color && (tick || this.cached?.active !== input.active || this.cached?.color !== input.color || modeChanged)) {
      const elapsedMs = Math.max(0, nowMs - (this.recordingStartMs ?? nowMs));
      colorTimeMs = Math.floor((elapsedMs + 0.001) / colorIntervalMs) * colorIntervalMs;
    }
    if (modeChanged || !this.cached || this.cached.level !== level || this.cached.nowMs !== colorTimeMs
      || this.cached.active !== input.active || this.cached.color !== input.color) {
      this.cached = { ...input, level, nowMs: colorTimeMs };
    }
    return this.cached;
  }

  reset(): void {
    this.cached = undefined;
    this.lastTickMs = undefined;
    this.lastNowMs = undefined;
    this.recordingStartMs = undefined;
  }
}
