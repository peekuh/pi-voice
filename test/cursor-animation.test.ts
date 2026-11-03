import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { CursorAnimation } from "../src/cursor-animation.ts";
import { renderVoiceCursor, type VoiceCursorFrame } from "../src/cursor.ts";

function frame(nowMs: number, level = 0, overrides: Partial<VoiceCursorFrame> = {}): VoiceCursorFrame {
  return { state: "recording", level, nowMs, reducedMotion: false, color: true, ...overrides };
}

function height(presentation: VoiceCursorFrame): number {
  return Math.round(presentation.level * 7);
}

function paint(presentation: VoiceCursorFrame): string {
  return renderVoiceCursor([CURSOR_MARKER + renderFakeCursor(" ")], presentation)[0];
}

test("initial presentation uses the current sound immediately and quantizes exact block heights", () => {
  for (const [level, expected] of [[0, 0], [0.3, 2], [0.8, 6], [1, 7], [-Infinity, 0], [Infinity, 7], [NaN, 0]]) {
    const presentation = new CursorAnimation().update(frame(0, level));
    assert.equal(presentation.level, expected / 7);
    assert.ok(stripTerminalSequences(paint(presentation)).includes("▁▂▃▄▅▆▇█"[expected]));
  }
});

test("noisy targets near every rounding boundary keep their established block height", () => {
  for (let boundary = 0.5; boundary < 7; boundary++) {
    for (const side of [-1, 1]) {
      const animation = new CursorAnimation();
      const initial = animation.update(frame(0, (boundary + side * 0.08) / 7));
      const initialPaint = stripTerminalSequences(paint(initial));
      for (let tick = 1; tick <= 90; tick++) {
        const noisyLevel = (boundary + (tick % 2 === 0 ? -0.08 : 0.08)) / 7;
        const next = animation.update(frame(tick * 1_000 / 30, noisyLevel));
        assert.equal(height(next), height(initial));
        assert.equal(stripTerminalSequences(paint(next)), initialPaint);
      }
    }
  }
});

test("sustained loud and quiet steps are monotonic, one bin at a time, and responsive", () => {
  const animation = new CursorAnimation();
  animation.update(frame(0));
  let previous = 0;
  let reachedLoudMs = Infinity;
  for (let tick = 1; tick <= 30; tick++) {
    const nowMs = tick * 1_000 / 30;
    const next = animation.update(frame(nowMs, 1));
    assert.equal(next.level, height(next) / 7);
    assert.ok(height(next) >= previous && height(next) <= previous + 1);
    previous = height(next);
    if (previous === 7) reachedLoudMs = Math.min(reachedLoudMs, nowMs);
  }
  assert.ok(reachedLoudMs > 0 && reachedLoudMs < 350, `rise took ${reachedLoudMs}ms`);

  let reachedQuietMs = Infinity;
  for (let tick = 1; tick <= 30; tick++) {
    const elapsedMs = tick * 1_000 / 30;
    const next = animation.update(frame(1_000 + elapsedMs));
    assert.ok(height(next) <= previous && height(next) >= previous - 1);
    previous = height(next);
    if (previous === 0) reachedQuietMs = Math.min(reachedQuietMs, elapsedMs);
  }
  assert.ok(reachedQuietMs > 0 && reachedQuietMs < 500, `fall took ${reachedQuietMs}ms`);
});

test("repeated samples inside one presentation tick cannot advance audio or color", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(80));
  for (let nowMs = 81; nowMs < 113; nowMs++) {
    const next = animation.update(frame(nowMs, 1));
    assert.equal(next, initial);
    assert.equal(paint(next), paint(initial));
  }
  const next = animation.update(frame(114, 1));
  assert.equal(height(next), 1);
  assert.equal(next.nowMs, 100);
});

test("extra high-frequency host samples do not accelerate presentation", () => {
  const sparse = new CursorAnimation();
  const frequent = new CursorAnimation();
  sparse.update(frame(0));
  frequent.update(frame(0));
  let denseFrame = frame(0);
  for (let nowMs = 1; nowMs <= 680; nowMs++) {
    const level = nowMs <= 350 ? 1 : 0;
    denseFrame = frequent.update(frame(nowMs, level));
    if (nowMs % 34 === 0) {
      const sparseFrame = sparse.update(frame(nowMs, level));
      assert.equal(height(denseFrame), height(sparseFrame), `height at ${nowMs}ms`);
      assert.equal(paint(denseFrame), paint(sparseFrame), `paint at ${nowMs}ms`);
    }
  }
});

test("variable presentation cadences retain bounded steps and sensible rise and fall times", () => {
  for (const cadence of [[16], [34], [11, 23, 17, 41, 8]]) {
    const animation = new CursorAnimation();
    animation.update(frame(0));
    let nowMs = 0;
    let previous = 0;
    let reachedLoudMs = Infinity;
    let tick = 0;
    while (nowMs < 1_000) {
      nowMs += cadence[tick++ % cadence.length];
      const current = height(animation.update(frame(nowMs, 1)));
      assert.ok(current >= previous && current <= previous + 1);
      previous = current;
      if (current === 7) reachedLoudMs = Math.min(reachedLoudMs, nowMs);
    }
    assert.ok(reachedLoudMs < 350, `${cadence}: rise took ${reachedLoudMs}ms`);
    const quietStartMs = nowMs;
    let reachedQuietMs = Infinity;
    while (nowMs - quietStartMs < 1_000) {
      nowMs += cadence[tick++ % cadence.length];
      const current = height(animation.update(frame(nowMs)));
      assert.ok(current <= previous && current >= previous - 1);
      previous = current;
      if (current === 0) reachedQuietMs = Math.min(reachedQuietMs, nowMs - quietStartMs);
    }
    assert.ok(reachedQuietMs < 500, `${cadence}: fall took ${reachedQuietMs}ms`);
  }
});

test("long frame stalls do not flash through multiple height bins or replay missed ticks", () => {
  const animation = new CursorAnimation();
  animation.update(frame(0));
  const afterStall = animation.update(frame(10_000, 1));
  assert.equal(height(afterStall), 1);
  assert.equal(animation.update(frame(10_001, 1)), afterStall);
  const afterAnotherStall = animation.update(frame(20_000, 1));
  assert.equal(height(afterAnotherStall), 2);
  const afterReversal = animation.update(frame(30_000));
  assert.ok(Math.abs(height(afterReversal) - height(afterAnotherStall)) <= 1);

  const loud = new CursorAnimation();
  loud.update(frame(0, 1));
  assert.equal(height(loud.update(frame(10_000))), 6);
});

test("steady audio uses stable 100ms color buckets and preserves the eight-second palette", () => {
  const animation = new CursorAnimation();
  const first = animation.update(frame(0, 3 / 7));
  for (const nowMs of [34, 67, 99]) {
    const next = animation.update(frame(nowMs, 3 / 7));
    assert.equal(next.nowMs, 0);
    assert.equal(paint(next), paint(first));
  }
  const hundred = animation.update(frame(100, 3 / 7));
  assert.equal(hundred.nowMs, 100);
  assert.notEqual(paint(hundred), paint(first));
  for (const nowMs of [134, 167, 199]) {
    assert.equal(paint(animation.update(frame(nowMs, 3 / 7))), paint(hundred));
  }
  assert.equal(animation.update(frame(200, 3 / 7)).nowMs, 200);
  assert.equal(paint(animation.update(frame(8_000, 3 / 7))), paint(first));
});

test("invalid and backwards clocks preserve presentation and recover without amplitude jumps", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(1_000));
  for (const nowMs of [NaN, Infinity, -Infinity]) {
    assert.equal(animation.update(frame(nowMs, 1)), initial);
  }
  assert.equal(animation.update(frame(10, 1)), initial);
  const recovered = animation.update(frame(44, 1));
  assert.equal(height(recovered), 1);
  assert.ok(Number.isFinite(recovered.nowMs));
  assert.equal(animation.update(frame(45, 0)), recovered);

  const invalidStart = new CursorAnimation();
  const start = invalidStart.update(frame(NaN, 0.5));
  assert.equal(start.nowMs, 0);
  assert.equal(invalidStart.update(frame(100, 1)), start);
  assert.ok(Math.abs(height(invalidStart.update(frame(134, 1))) - height(start)) <= 1);
});

test("transcribing and reduced motion are steady and mode changes bypass the frame cache", () => {
  for (const overrides of [{ state: "transcribing" as const }, { reducedMotion: true }]) {
    const animation = new CursorAnimation();
    animation.update(frame(0, 1));
    const steady = animation.update(frame(1, 0, overrides));
    assert.equal(steady.nowMs, 0);
    assert.equal(steady.level, overrides.state === "transcribing" ? 3 / 7 : 5 / 7);
    for (const nowMs of [2, 100, 8_999, NaN]) {
      const next = animation.update(frame(nowMs, 1, overrides));
      assert.equal(next, steady);
      assert.equal(paint(next), paint(steady));
    }
    const resumed = animation.update(frame(9_000, 0));
    assert.equal(height(resumed), 0, "resuming recording has no stale amplitude or exit transition");
    assert.equal(resumed.state, "recording");
    assert.equal(resumed.reducedMotion, false);
  }
  const animation = new CursorAnimation();
  const reduced = animation.update(frame(0, 1, { reducedMotion: true }));
  const transcribing = animation.update(frame(1, 1, { reducedMotion: true, state: "transcribing" }));
  assert.notEqual(paint(reduced), paint(transcribing));
});

test("color preference changes immediately without advancing a cached height", () => {
  const animation = new CursorAnimation();
  const first = animation.update(frame(0));
  const noColor = animation.update(frame(1, 1, { color: false }));
  assert.equal(height(noColor), height(first));
  assert.equal(noColor.nowMs, first.nowMs);
  assert.equal(paint(noColor).replace(CURSOR_MARKER, "").includes("\x1b"), false);
  const restored = animation.update(frame(2, 1));
  assert.equal(paint(restored), paint(first));
});

test("reset removes previous session amplitude, frame phase and mode", () => {
  const animation = new CursorAnimation();
  animation.update(frame(10_000, 1));
  animation.update(frame(10_034, 1));
  animation.reset();
  const fresh = animation.update(frame(0));
  assert.equal(height(fresh), 0);
  assert.equal(fresh.nowMs, 0);
  assert.equal(height(animation.update(frame(34, 1))), 1);
  animation.update(frame(35, 1, { state: "transcribing" }));
  animation.reset();
  const loud = animation.update(frame(1, 1));
  assert.equal(height(loud), 7, "a fresh session reflects current sound without a fake entrance");
  assert.equal(loud.state, "recording");
});
