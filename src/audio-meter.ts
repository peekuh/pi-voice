const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = 256;
const WINDOW_MS = WINDOW_SAMPLES * 1_000 / SAMPLE_RATE;
const ENVELOPE_TAU_MS = 50;
const ENVELOPE_WEIGHT = 1 - Math.exp(-WINDOW_MS / ENVELOPE_TAU_MS);
const HEIGHT_GAIN = 60 / 8;
const ACTIVE_RMS = 0.001;
const TRANSPORT_GRACE_MS = 200;

export class AudioMeter {
  private lowByte = -1;
  private windowEnergy = 0;
  private windowSamples = 0;
  private strength = 0;
  private active = false;
  private lastWindowMs: number | undefined;
  private lastInputMs: number | undefined;
  private clockMs: number | undefined;

  push(pcm: Uint8Array, nowMs = performance.now()): void {
    const now = this.time(nowMs);
    let offset = 0;
    if (pcm.byteLength === 0) return;
    if (this.lastInputMs !== undefined) {
      // Arrival jitter is not silence; completed PCM windows drive the envelope.
      const durationMs = pcm.byteLength * 1_000 / (SAMPLE_RATE * 2);
      const gapMs = Math.max(0, now - this.lastInputMs - Math.max(TRANSPORT_GRACE_MS, durationMs));
      this.strength *= Math.exp(-gapMs / ENVELOPE_TAU_MS);
    }
    this.lastInputMs = now;
    if (this.lowByte >= 0) {
      this.consume(this.lowByte | pcm[offset++]! << 8, now);
      this.lowByte = -1;
    }
    while (offset + 1 < pcm.byteLength) {
      this.consume(pcm[offset]! | pcm[offset + 1]! << 8, now);
      offset += 2;
    }
    if (offset < pcm.byteLength) this.lowByte = pcm[offset]!;
  }

  reset(): void {
    this.lowByte = -1;
    this.windowEnergy = 0;
    this.windowSamples = 0;
    this.strength = 0;
    this.active = false;
    this.lastWindowMs = undefined;
    this.lastInputMs = undefined;
    this.clockMs = undefined;
  }

  sample(nowMs = performance.now()): number {
    const now = this.time(nowMs);
    if (this.lastInputMs === undefined) return 0;
    const staleMs = Math.max(0, now - this.lastInputMs - TRANSPORT_GRACE_MS);
    return this.strength * Math.exp(-staleMs / ENVELOPE_TAU_MS);
  }

  isActive(nowMs = performance.now()): boolean {
    const now = this.time(nowMs);
    return this.active && this.lastWindowMs !== undefined && now - this.lastWindowMs <= TRANSPORT_GRACE_MS;
  }

  private time(nowMs: number): number {
    if (Number.isFinite(nowMs) && nowMs >= 0) {
      this.clockMs = Math.max(this.clockMs ?? 0, nowMs);
    }
    return this.clockMs ?? 0;
  }

  private consume(unsigned: number, now: number): void {
    const sample = unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
    this.windowEnergy += sample * sample;
    if (++this.windowSamples !== WINDOW_SAMPLES) return;
    const rms = Math.sqrt(this.windowEnergy / WINDOW_SAMPLES) / 0x8000;
    // This square-root sensitivity fits measured Claude cursor heights, not its internals.
    const target = Math.min(1, HEIGHT_GAIN * Math.sqrt(rms));
    this.strength += (target - this.strength) * ENVELOPE_WEIGHT;
    this.active = rms > ACTIVE_RMS;
    this.lastWindowMs = now;
    this.windowEnergy = 0;
    this.windowSamples = 0;
  }
}
