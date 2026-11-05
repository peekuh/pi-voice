import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { AudioMeter } from "../src/audio-meter.ts";

function pcm(milliseconds: number, amplitude = 0): Buffer {
  const audio = Buffer.alloc(milliseconds * 16 * 2);
  for (let sample = 0; sample < audio.byteLength / 2; sample++) {
    audio.writeInt16LE(amplitude, sample * 2);
  }
  return audio;
}

function sine(milliseconds: number, amplitudeDb: number): Buffer {
  const audio = Buffer.alloc(milliseconds * 16 * 2);
  const amplitude = 0x8000 * 10 ** (amplitudeDb / 20);
  for (let sample = 0; sample < audio.byteLength / 2; sample++) {
    audio.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * sample / 16)), sample * 2);
  }
  return audio;
}

function height(strength: number): number {
  return Math.max(1, Math.min(8, Math.round(strength * 8)));
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} differs from ${expected}`);
}

function splitPush(meter: AudioMeter, audio: Uint8Array, sizes: readonly number[], timed = false): void {
  let offset = 0;
  let index = 0;
  while (offset < audio.byteLength) {
    const end = Math.min(audio.byteLength, offset + sizes[index++ % sizes.length]!);
    meter.push(audio.subarray(offset, end), timed ? end / 32 : 0);
    offset = end;
  }
}

function assertSteadyDelivery(deliveries: readonly { atMs: number; durationMs: number }[], fps: number): void {
  const meter = new AudioMeter();
  meter.push(pcm(480, 16_000), 0);
  let nextDelivery = 0;
  let previous = meter.sample(0);
  const endMs = deliveries[deliveries.length - 1]!.atMs;
  for (let frame = 0; frame * 1_000 / fps <= endMs; frame++) {
    const now = frame * 1_000 / fps;
    while (nextDelivery < deliveries.length && deliveries[nextDelivery]!.atMs <= now) {
      const delivery = deliveries[nextDelivery++]!;
      meter.push(pcm(delivery.durationMs, 16_000), delivery.atMs);
    }
    const current = meter.sample(now);
    assert.ok(current > 0.99, `sustained sound dipped to ${current} at ${now}ms (${fps}Hz)`);
    assert.ok(current + 1e-12 >= previous, `delivery caused a drop from ${previous} to ${current} at ${now}ms`);
    assert.equal(meter.isActive(now), true);
    previous = current;
  }
}

test("measured sine plateaus map -50dB amplitude to height 3 and -35dB to height 7", () => {
  for (const [db, expectedHeight] of [[-50, 3], [-35, 7], [-20, 8]] as const) {
    const meter = new AudioMeter();
    meter.push(sine(480, db), 480);
    const strength = meter.sample(480);
    assert.equal(height(strength), expectedHeight);
    const targetHeight = Math.min(8, 60 * Math.sqrt(10 ** (db / 20) / Math.sqrt(2)));
    assert.ok(Math.abs(strength * 8 - targetHeight) < 0.04, `${db}dB produced height ${strength * 8}`);
    assert.equal(meter.isActive(480), true);
  }
});

test("silence is quiet and raw activity threshold is independent of drawable strength", () => {
  const meter = new AudioMeter();
  meter.push(pcm(320), 0);
  assert.equal(meter.sample(0), 0);
  assert.equal(meter.isActive(0), false);
  meter.push(pcm(320, 32), 0);
  assert.ok(meter.sample(0) > 0);
  assert.equal(meter.isActive(0), false);
  meter.push(pcm(16, 33), 16);
  assert.equal(meter.isActive(16), true);
  meter.push(pcm(16, -32), 32);
  assert.equal(meter.isActive(32), false);
});

test("signed little-endian samples and both clipping limits have symmetric response", () => {
  for (const [positive, negative] of [[8_000, -8_000], [32_767, -32_768]]) {
    const first = new AudioMeter();
    const second = new AudioMeter();
    first.push(pcm(320, positive), 0);
    second.push(pcm(320, negative), 0);
    close(first.sample(0), second.sample(0));
    assert.equal(first.isActive(0), true);
    assert.equal(second.isActive(0), true);
    assert.ok(first.sample(0) > 0.99 && first.sample(0) <= 1);
  }
});

test("a complete 256-sample window drives onset even when its last byte arrives separately", () => {
  const meter = new AudioMeter();
  const audio = pcm(16, 16_000);
  meter.push(audio.subarray(0, audio.byteLength - 1), 0);
  assert.equal(meter.sample(0), 0);
  assert.equal(meter.isActive(0), false);
  meter.push(audio.subarray(audio.byteLength - 1), 0);
  const first = meter.sample(0);
  assert.ok(first > 0.25 && first < 0.30);
  assert.equal(height(first), 2);
  assert.equal(meter.isActive(0), true);
});

test("onset rises monotonically through measured height bounds without a one-bin limiter", () => {
  const meter = new AudioMeter();
  let previous = 0;
  for (let now = 16; now <= 160; now += 16) {
    meter.push(pcm(16, 16_000), now);
    const strength = meter.sample(now);
    assert.ok(strength > previous && strength <= 1);
    if (now === 32) assert.ok(height(strength) >= 4);
    if (now === 48) assert.ok(height(strength) >= 5);
    if (now === 80) assert.ok(height(strength) >= 6);
    if (now === 112) assert.ok(height(strength) >= 7);
    if (now === 160) assert.equal(height(strength), 8);
    previous = strength;
  }
});

test("silent PCM turns activity gray in one window while height decays smoothly without a hold", () => {
  const meter = new AudioMeter();
  meter.push(pcm(480, 16_000), 0);
  const peak = meter.sample(0);
  let previous = peak;
  for (let now = 16; now <= 160; now += 16) {
    meter.push(pcm(16), now);
    const strength = meter.sample(now);
    assert.ok(strength > 0 && strength < previous);
    assert.equal(meter.isActive(now), false);
    if (now === 16) {
      assert.ok(strength < peak * 0.75);
      assert.equal(height(strength), 6);
    }
    if (now === 48) assert.ok(height(strength) <= 3);
    if (now >= 96) assert.equal(height(strength), 1);
    if (now === 160) assert.ok(strength < 0.05);
    previous = strength;
  }
});

test("a batched window's latest raw RMS controls activity rather than its earlier loud peak", () => {
  const meter = new AudioMeter();
  meter.push(Buffer.concat([pcm(160, 16_000), pcm(16)]), 176);
  assert.equal(meter.isActive(176), false);
  assert.ok(height(meter.sample(176)) >= 5);
});

test("sustained PCM batches at 64, 128, and 160ms have no dips at 30 or 60Hz", () => {
  for (const durationMs of [64, 128, 160]) {
    const deliveries = Array.from({ length: 24 }, (_, index) => ({ atMs: index * durationMs, durationMs }));
    for (const fps of [30, 60]) assertSteadyDelivery(deliveries, fps);
  }
});

test("mixed PCM batch sizes and delivery jitter do not pulse steady sound", () => {
  let audioTimeMs = 0;
  const deliveries = [{ atMs: 0, durationMs: 128 }];
  const durations = [64, 160, 128, 64, 128, 160, 64, 160];
  const delays = [24, 7, 46, 2, 39, 11, 53, 4];
  for (let index = 0; index < 48; index++) {
    const durationMs = durations[index % durations.length]!;
    audioTimeMs += durationMs;
    deliveries.push({ atMs: audioTimeMs + delays[index % delays.length]!, durationMs });
  }
  for (const fps of [30, 60]) assertSteadyDelivery(deliveries, fps);
});

test("silent batches lower the envelope immediately instead of waiting for transport grace", () => {
  for (const durationMs of [16, 64, 128, 160]) {
    const meter = new AudioMeter();
    meter.push(pcm(480, 16_000), 0);
    let previous = meter.sample(0);
    let now = 0;
    while (now < 160) {
      now += durationMs;
      meter.push(pcm(durationMs), now);
      const current = meter.sample(now);
      assert.ok(current < previous);
      assert.equal(meter.isActive(now), false);
      if (now >= 96) assert.equal(height(current), 1);
      if (now >= 160) assert.ok(current < 0.05);
      previous = current;
    }
  }
});

test("stale input loses activity after batching grace and settles regardless of sampling frequency", () => {
  const frequent = new AudioMeter();
  const sparse = new AudioMeter();
  frequent.push(pcm(480, 16_000), 0);
  sparse.push(pcm(480, 16_000), 0);
  const peak = frequent.sample(0);
  let previous = peak;
  for (let frame = 1; frame <= 24; frame++) {
    const now = frame * 1_000 / 60;
    const current = frequent.sample(now);
    assert.ok(current <= previous);
    if (now <= 200) close(current, peak);
    assert.equal(frequent.isActive(now), now <= 200);
    if (frame % 6 === 0) close(current, sparse.sample(now));
    previous = current;
  }
  assert.ok(frequent.sample(400) < 0.02);
  assert.equal(height(frequent.sample(400)), 1);
  close(frequent.sample(400), sparse.sample(400));
  assert.equal(sparse.isActive(400), false);
});

test("empty pushes and incomplete windows cannot keep stale activity alive", () => {
  const meter = new AudioMeter();
  meter.push(pcm(16, 16_000), 0);
  meter.push(new Uint8Array(), 100);
  meter.push(new Uint8Array(), 200);
  meter.push(Uint8Array.of(255), 201);
  assert.equal(meter.isActive(201), false);
  meter.push(new Uint8Array(), 300);
  assert.equal(meter.isActive(300), false);
});

test("input after a long gap does not revive the old envelope or activity", () => {
  const meter = new AudioMeter();
  meter.push(pcm(480, 16_000), 0);
  meter.push(pcm(16), 1_000);
  assert.ok(meter.sample(1_000) < 1e-6);
  assert.equal(meter.isActive(1_000), false);
  meter.push(pcm(16, 200), 1_016);
  assert.ok(meter.sample(1_016) > 0 && meter.sample(1_016) < 0.2);
  assert.equal(meter.isActive(1_016), true);
});

test("arbitrary byte boundaries and single-byte chunks preserve all signed PCM samples", () => {
  const audio = Buffer.concat([pcm(16, -12_000), pcm(16, 300), pcm(32), pcm(48, 4_000)]);
  const whole = new AudioMeter();
  whole.push(audio, 0);
  const atInput = whole.sample(0);
  const afterDecay = whole.sample(280);
  for (const sizes of [[1], [1, 7, 511, 2, 513, 17], [audio.byteLength - 1, 1]]) {
    const split = new AudioMeter();
    splitPush(split, audio, sizes);
    close(split.sample(0), atInput);
    assert.equal(split.isActive(0), true);
    close(split.sample(280), afterDecay);
    assert.equal(split.isActive(280), false);
  }
});

test("levels and latest activity are independent of chunk size at PCM playback speed", () => {
  const audio = Buffer.concat([pcm(32, 300), pcm(48, 12_000), pcm(64), pcm(32, -2_000), pcm(16)]);
  const now = audio.byteLength / 32;
  const whole = new AudioMeter();
  whole.push(audio, now);
  const atInput = whole.sample(now);
  const afterDecay = whole.sample(now + 280);
  for (const sizes of [[1], [32], [512], [1, 7, 511, 2, 513, 17]]) {
    const split = new AudioMeter();
    splitPush(split, audio, sizes, true);
    close(split.sample(now), atInput);
    assert.equal(split.isActive(now), false);
    close(split.sample(now + 280), afterDecay);
  }
});

test("reset clears accumulated energy, incomplete samples, activity, envelope, and timing", () => {
  const meter = new AudioMeter();
  meter.push(pcm(16, 16_000), 1_000);
  meter.push(Buffer.concat([pcm(15, 16_000), Uint8Array.of(255)]), 1_015);
  meter.reset();
  assert.equal(meter.sample(0), 0);
  assert.equal(meter.isActive(0), false);
  meter.push(pcm(16), 0);
  assert.equal(meter.sample(0), 0);
  meter.push(pcm(16, 16_000), 16);
  const clean = new AudioMeter();
  clean.push(pcm(16, 16_000), 16);
  close(meter.sample(16), clean.sample(16));
  assert.equal(meter.isActive(16), true);
  meter.reset();
  meter.reset();
  assert.equal(meter.sample(0), 0);
  assert.equal(meter.isActive(0), false);
});

test("invalid and backwards timestamps cannot rewind envelope decay or activity freshness", () => {
  const meter = new AudioMeter();
  assert.equal(meter.sample(Number.NaN), 0);
  assert.equal(meter.isActive(Number.NaN), false);
  meter.push(pcm(16, 16_000), 0);
  const peak = meter.sample(0);
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    close(meter.sample(now), peak);
    assert.equal(meter.isActive(now), true);
  }
  const falling = meter.sample(280);
  assert.ok(falling > 0 && falling < peak);
  close(meter.sample(0), falling);
  assert.equal(meter.isActive(0), false);
  meter.push(pcm(16, 200), Number.NaN);
  const quiet = meter.sample(Number.NaN);
  assert.ok(Number.isFinite(quiet) && quiet >= 0 && quiet <= 1);
  assert.equal(meter.isActive(Number.NaN), true);
  assert.equal(meter.sample(Number.MAX_VALUE), 0);
  assert.equal(meter.isActive(Number.MAX_VALUE), false);
  meter.reset();
  meter.push(pcm(16, -16_000), Number.NaN);
  assert.ok(meter.sample(0) > 0.25);
  assert.equal(meter.isActive(0), true);
});
