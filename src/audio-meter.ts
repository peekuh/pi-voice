const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = SAMPLE_RATE * 20 / 1_000;
const FLOOR_DB = -60;
const LOUD_DB = -12;
const ATTACK_WEIGHT = 1 - Math.exp(-20 / 8);
const PEAK_HOLD_MS = 40;
const RELEASE_MS = 140;

export class AudioMeter {
  private lowByte = -1;
  private windowEnergy = 0;
  private windowSamples = 0;
  private level = 0;
  private holdMs = 0;
  private lastInputMs: number | undefined;
  private clockMs: number | undefined;

  push(pcm: Uint8Array, nowMs = performance.now()): void {
    const now = this.time(nowMs);
    let offset = 0;
    if (pcm.byteLength === 0) return;
    if (this.lastInputMs !== undefined) {
      // Audio frames already account for their own duration; only decay gaps between them.
      this.release(Math.max(0, now - this.lastInputMs - pcm.byteLength * 1_000 / (SAMPLE_RATE * 2)), 0);
    }
    this.lastInputMs = now;
    if (this.lowByte >= 0) {
      this.consume(this.lowByte | pcm[offset++]! << 8);
      this.lowByte = -1;
    }
    while (offset + 1 < pcm.byteLength) {
      this.consume(pcm[offset]! | pcm[offset + 1]! << 8);
      offset += 2;
    }
    if (offset < pcm.byteLength) this.lowByte = pcm[offset]!;
  }

  reset(): void {
    this.lowByte = -1;
    this.windowEnergy = 0;
    this.windowSamples = 0;
    this.level = 0;
    this.holdMs = 0;
    this.lastInputMs = undefined;
    this.clockMs = undefined;
  }

  sample(nowMs = performance.now()): number {
    const now = this.time(nowMs);
    if (this.lastInputMs === undefined) return 0;
    const releaseMs = Math.max(0, now - this.lastInputMs - this.holdMs);
    return Math.max(0, Math.min(1, this.level - releaseMs / RELEASE_MS));
  }

  private time(nowMs: number): number {
    if (Number.isFinite(nowMs) && nowMs >= 0) {
      this.clockMs = Math.max(this.clockMs ?? 0, nowMs);
    }
    return this.clockMs ?? 0;
  }

  private consume(unsigned: number): void {
    const sample = unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
    this.windowEnergy += sample * sample;
    if (++this.windowSamples !== WINDOW_SAMPLES) return;
    const rms = Math.sqrt(this.windowEnergy / WINDOW_SAMPLES) / 0x8000;
    const target = rms <= 0.001 ? 0 : Math.min(1, (20 * Math.log10(rms) - FLOOR_DB) / (LOUD_DB - FLOOR_DB));
    this.windowEnergy = 0;
    this.windowSamples = 0;
    if (target >= this.level && target > 0) {
      this.level += (target - this.level) * ATTACK_WEIGHT;
      this.holdMs = PEAK_HOLD_MS;
    } else {
      this.release(WINDOW_SAMPLES * 1_000 / SAMPLE_RATE, target);
    }
  }

  private release(elapsedMs: number, floor: number): void {
    const releaseMs = Math.max(0, elapsedMs - this.holdMs);
    this.holdMs = Math.max(0, this.holdMs - elapsedMs);
    this.level = Math.max(floor, this.level - releaseMs / RELEASE_MS);
  }
}
