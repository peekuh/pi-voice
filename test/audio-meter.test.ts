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

function level(amplitude: number): number {
  const meter = new AudioMeter();
  meter.push(pcm(40, amplitude), 0);
  return meter.sample(0);
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

test("silence and sub-floor input stay quiet, with quiet speech below loud speech", () => {
  assert.equal(level(0), 0);
  assert.equal(level(32), 0);
  const quiet = level(200);
  const speech = level(2_000);
  const loud = level(8_000);
  assert.ok(quiet > 0.2 && quiet < 0.4);
  assert.ok(speech > quiet);
  assert.ok(loud > speech && loud <= 1);
});

test("logarithmic speech range maps -30dB near the middle of the usable range", () => {
  const mid = level(Math.round(0x8000 * 10 ** (-30 / 20)));
  assert.ok(mid > 0.61 && mid < 0.63);
  assert.ok(level(9_000) > 0.99);
});

test("signed little-endian input treats negative samples and clipping symmetrically", () => {
  close(level(-8_000), level(8_000));
  close(level(-32_768), level(32_767));
  assert.ok(level(-32_768) > 0.99);
  const alternating = pcm(40, 32_767);
  for (let offset = 0; offset < alternating.byteLength; offset += 4) {
    alternating.writeInt16LE(-32_768, offset);
  }
  const meter = new AudioMeter();
  meter.push(alternating, 0);
  assert.ok(meter.sample(0) > 0.99 && meter.sample(0) <= 1);
});

test("attack reacts to a completed 20ms RMS window rather than byte chunk size", () => {
  const meter = new AudioMeter();
  const audio = pcm(20, 16_000);
  meter.push(audio.subarray(0, audio.byteLength - 1), 0);
  assert.equal(meter.sample(0), 0);
  meter.push(audio.subarray(audio.byteLength - 1), 0);
  assert.ok(meter.sample(0) > 0.9);
});

test("one loud sample remains visible through the next display frame", () => {
  const meter = new AudioMeter();
  const click = pcm(20);
  click.writeInt16LE(32_767, 0);
  meter.push(click, 0);
  const peak = meter.sample(0);
  assert.ok(peak > 0.6);
  close(meter.sample(40), peak);
  assert.ok(meter.sample(80) < peak);
  assert.equal(meter.sample(200), 0);
});

test("new silence releases gently after the peak hold and reaches quiet within 200ms", () => {
  const meter = new AudioMeter();
  meter.push(pcm(20, 16_000), 20);
  const peak = meter.sample(20);
  meter.push(pcm(20), 40);
  close(meter.sample(40), peak);
  meter.push(pcm(20), 60);
  close(meter.sample(60), peak);
  meter.push(pcm(20), 80);
  const falling = meter.sample(80);
  assert.ok(falling > 0 && falling < peak);
  for (let now = 100; now <= 220; now += 20) meter.push(pcm(20), now);
  assert.equal(meter.sample(220), 0);
});

test("stale input decays without PCM and sampling does not accelerate the envelope", () => {
  const sampled = new AudioMeter();
  const untouched = new AudioMeter();
  sampled.push(pcm(40, 16_000), 0);
  untouched.push(pcm(40, 16_000), 0);
  const peak = sampled.sample(0);
  close(sampled.sample(40), peak);
  const falling = sampled.sample(80);
  assert.ok(falling > 0 && falling < peak);
  close(sampled.sample(80), untouched.sample(80));
  close(sampled.sample(120), untouched.sample(120));
  assert.equal(sampled.sample(180), 0);
  assert.equal(sampled.sample(10_000), 0);
});

test("empty pushes do not keep stale audio alive", () => {
  const meter = new AudioMeter();
  meter.push(pcm(20, 16_000), 0);
  meter.push(new Uint8Array(), 100);
  meter.push(new Uint8Array(), 200);
  assert.equal(meter.sample(200), 0);
});

test("input after a long gap does not revive the old peak", () => {
  const meter = new AudioMeter();
  meter.push(pcm(20, 16_000), 0);
  meter.push(pcm(20), 1_000);
  assert.equal(meter.sample(1_000), 0);
  meter.push(pcm(20, 200), 1_020);
  assert.ok(meter.sample(1_020) > 0 && meter.sample(1_020) < 0.4);
});

test("arbitrary byte boundaries and single-byte chunks preserve all signed PCM samples", () => {
  const audio = Buffer.concat([pcm(20, -12_000), pcm(20, 300), pcm(20), pcm(40, 4_000)]);
  const whole = new AudioMeter();
  whole.push(audio, 0);
  const atInput = whole.sample(0);
  const afterDecay = whole.sample(80);
  for (const sizes of [[1], [1, 7, 639, 2, 641, 17], [audio.byteLength - 1, 1]]) {
    const split = new AudioMeter();
    splitPush(split, audio, sizes);
    close(split.sample(0), atInput);
    close(split.sample(80), afterDecay);
  }
});

test("levels are independent of chunk size when chunks arrive at PCM playback speed", () => {
  const audio = Buffer.concat([pcm(20, 300), pcm(20, 12_000), pcm(30), pcm(20, -2_000), pcm(10)]);
  const now = audio.byteLength / 32;
  const whole = new AudioMeter();
  whole.push(audio, now);
  const atInput = whole.sample(now);
  const afterDecay = whole.sample(now + 80);
  for (const sizes of [[1], [32], [640], [1, 7, 639, 2, 641, 17]]) {
    const split = new AudioMeter();
    splitPush(split, audio, sizes, true);
    close(split.sample(now), atInput);
    close(split.sample(now + 80), afterDecay);
  }
});

test("reset clears accumulated energy, incomplete samples, peaks, and timing", () => {
  const meter = new AudioMeter();
  meter.push(pcm(20, 16_000), 1_000);
  meter.push(Buffer.concat([pcm(19, 16_000), Uint8Array.of(255)]), 1_019);
  meter.reset();
  assert.equal(meter.sample(0), 0);
  meter.push(pcm(20), 0);
  assert.equal(meter.sample(0), 0);
  meter.push(pcm(20, 16_000), 20);
  const clean = new AudioMeter();
  clean.push(pcm(20, 16_000), 20);
  close(meter.sample(20), clean.sample(20));
  meter.reset();
  meter.reset();
  assert.equal(meter.sample(0), 0);
});

test("zero, invalid, and backwards times keep levels finite, bounded, and monotonic in time", () => {
  const meter = new AudioMeter();
  assert.equal(meter.sample(Number.NaN), 0);
  meter.push(pcm(20, 16_000), 0);
  const peak = meter.sample(0);
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    close(meter.sample(now), peak);
  }
  const falling = meter.sample(100);
  assert.ok(falling >= 0 && falling < peak);
  close(meter.sample(0), falling);
  meter.push(pcm(20, 200), Number.NaN);
  const quiet = meter.sample(Number.NaN);
  assert.ok(Number.isFinite(quiet) && quiet >= 0 && quiet <= 1);
  assert.equal(meter.sample(Number.MAX_VALUE), 0);
  meter.reset();
  meter.push(pcm(20, -16_000), Number.NaN);
  assert.ok(meter.sample(0) > 0.9);
});
