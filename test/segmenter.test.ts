import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { createSegmenter } from "../src/segmenter.ts";

function pcm(milliseconds: number, amplitude = 0): Buffer {
  const audio = Buffer.alloc(milliseconds * 16 * 2);
  for (let sample = 0; sample < audio.byteLength / 2; sample++) {
    audio.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  return audio;
}

test("silence and quiet background never produce speech segments", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  segmenter.push(pcm(10_000));
  segmenter.push(pcm(3_000, 120));
  segmenter.finish();
  segmenter.finish();
  assert.deepEqual(segments, []);
});

test("a 600ms pause commits before finish with only the latest 240ms pre-roll", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  segmenter.push(pcm(1_200));
  segmenter.push(pcm(300, 6_000));
  segmenter.push(pcm(570));
  assert.equal(segments.length, 0);
  segmenter.push(pcm(30));
  assert.equal(segments.length, 1);
  assert.deepEqual(Buffer.from(segments[0]!), Buffer.concat([pcm(240), pcm(300, 6_000), pcm(600)]));
  segmenter.finish();
  assert.equal(segments.length, 1);
});

test("speech below 200ms is discarded but an exact 200ms tail is retained", () => {
  const short: Uint8Array[] = [];
  const first = createSegmenter((audio) => short.push(audio));
  first.push(pcm(180, 6_000));
  first.push(pcm(600));
  first.finish();
  assert.deepEqual(short, []);

  const enough: Uint8Array[] = [];
  const second = createSegmenter((audio) => enough.push(audio));
  second.push(pcm(200, 6_000));
  second.finish();
  assert.equal(enough.length, 1);
  assert.deepEqual(Buffer.from(enough[0]!), pcm(200, 6_000));
});

test("short pauses remain inside one utterance", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  const audio = Buffer.concat([pcm(240, 6_000), pcm(300), pcm(240, 4_000), pcm(600)]);
  segmenter.push(audio);
  assert.equal(segments.length, 1);
  assert.deepEqual(Buffer.from(segments[0]!), audio);
  segmenter.finish();
  assert.equal(segments.length, 1);
});

test("continuous speech splits at 12 seconds without overlap or lost tail", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  const audio = pcm(24_030, 6_000);
  segmenter.push(audio);
  assert.deepEqual(segments.map((part) => part.byteLength), [384_000, 384_000]);
  segmenter.finish();
  assert.deepEqual(segments.map((part) => part.byteLength), [384_000, 384_000, 960]);
  assert.deepEqual(Buffer.concat(segments), audio);
  segmenter.finish();
  assert.equal(segments.length, 3);
});

test("pre-roll counts toward the 12-second cap and hard splits do not submit silence", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  segmenter.push(pcm(240));
  segmenter.push(pcm(11_760, 6_000));
  assert.equal(segments[0]?.byteLength, 384_000);
  segmenter.push(pcm(600));
  segmenter.finish();
  assert.equal(segments.length, 1);
});

test("arbitrary byte boundaries including split PCM samples preserve exact segments", () => {
  const audio = Buffer.concat([pcm(300), pcm(330, 6_000), pcm(600), pcm(250, 4_000)]);
  const whole: Uint8Array[] = [];
  const first = createSegmenter((segment) => whole.push(segment));
  first.push(audio);
  first.finish();
  const split: Uint8Array[] = [];
  const second = createSegmenter((segment) => split.push(segment));
  const sizes = [1, 7, 959, 2, 961, 17];
  let offset = 0;
  let index = 0;
  while (offset < audio.byteLength) {
    const end = Math.min(audio.byteLength, offset + sizes[index++ % sizes.length]!);
    second.push(audio.subarray(offset, end));
    offset = end;
  }
  second.finish();
  assert.equal(split.length, 2);
  assert.deepEqual(split, whole);
});

test("idle noise adaptation rejects energy above the absolute floor but below ambient ratio", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  segmenter.push(pcm(3_000, 200));
  segmenter.push(pcm(300, 350));
  segmenter.push(pcm(600, 200));
  assert.deepEqual(segments, []);
  segmenter.push(pcm(300, 1_000));
  segmenter.push(pcm(600, 200));
  assert.equal(segments.length, 1);
});

test("flush rejects an incomplete PCM sample rather than silently trimming it", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  segmenter.push(pcm(300, 6_000));
  segmenter.push(Uint8Array.of(1));
  assert.throws(() => segmenter.finish(), /incomplete 16-bit sample/);
  assert.deepEqual(segments, []);
});

test("cancel discards the tail and ignores later input or flush", () => {
  const segments: Uint8Array[] = [];
  const segmenter = createSegmenter((audio) => segments.push(audio));
  segmenter.push(pcm(300, 6_000));
  segmenter.cancel();
  segmenter.push(pcm(600));
  segmenter.finish();
  assert.deepEqual(segments, []);
});
