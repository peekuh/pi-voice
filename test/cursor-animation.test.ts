import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CursorAnimation, CURSOR_FRAME_INTERVAL_MS } from "../src/cursor-animation.ts";
import { renderVoiceCursor } from "../src/cursor.ts";
import type { VoiceCursorFrame } from "../src/cursor-style.ts";

function frame(nowMs: number, level = 0, overrides: Partial<VoiceCursorFrame> = {}): VoiceCursorFrame {
  return { state: "recording", level, active: true, nowMs, reducedMotion: false, color: true, ...overrides };
}

function height(presentation: VoiceCursorFrame): number {
  return Math.round(presentation.level * 7) + 1;
}

function paint(presentation: VoiceCursorFrame): string {
  return renderVoiceCursor([CURSOR_MARKER + renderFakeCursor(" ")], presentation)[0];
}

function color(presentation: VoiceCursorFrame): string {
  const match = paint(presentation).match(/\x1b\[38;2;\d+;\d+;\d+m/);
  assert.ok(match);
  return match[0];
}

test("meter strength is height divided by eight, not drawable bin divided by seven", () => {
  for (let expected = 1; expected <= 8; expected++) {
    const animation = new CursorAnimation();
    const result = animation.update(frame(5_000, expected / 8));
    assert.equal(height(result), expected);
    assert.equal(result.level, (expected - 1) / 7);
  }
  for (const level of [-Infinity, -1, NaN, 0]) {
    assert.equal(height(new CursorAnimation().update(frame(0, level))), 1);
  }
  for (const level of [1, 2, Infinity]) {
    assert.equal(height(new CursorAnimation().update(frame(0, level))), 8);
  }
});

test("measured steady sine strengths retain quiet sensitivity without another amplitude curve", () => {
  for (const [amplitudeDb, expected] of [[-50, 3], [-35, 7], [-20, 8]]) {
    const rms = 10 ** (amplitudeDb / 20) / Math.SQRT2;
    const strength = Math.min(1, 60 * Math.sqrt(rms) / 8);
    assert.equal(height(new CursorAnimation().update(frame(0, strength))), expected);
  }
});

test("already-smoothed acoustic changes can skip bins on the next display tick", () => {
  const animation = new CursorAnimation();
  assert.equal(height(animation.update(frame(0, 1 / 8))), 1);
  assert.equal(height(animation.update(frame(CURSOR_FRAME_INTERVAL_MS, 1))), 8);
  assert.equal(height(animation.update(frame(2 * CURSOR_FRAME_INTERVAL_MS, 1 / 8))), 1);
  for (const [index, expected] of [2, 4, 5, 6, 7, 8, 6, 4, 3, 2, 1].entries()) {
    assert.equal(height(animation.update(frame((index + 3) * CURSOR_FRAME_INTERVAL_MS, expected / 8))), expected);
  }
});

test("same-tick input is cached and the latest signal reaches the next display tick", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(0, 0));
  assert.equal(animation.update(frame(1, 1)), initial);
  assert.equal(animation.update(frame(5, 0.5)), initial);
  assert.equal(height(animation.update(frame(CURSOR_FRAME_INTERVAL_MS, 0.5))), 4);
});

test("height updates independently of the slower color clock", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(10_000, 1 / 8));
  const taller = animation.update(frame(10_000 + CURSOR_FRAME_INTERVAL_MS, 4 / 8));
  assert.equal(height(taller), 4);
  assert.equal(color(taller), color(initial));
  const brighter = animation.update(frame(10_000 + 4 * CURSOR_FRAME_INTERVAL_MS, 4 / 8));
  assert.equal(height(brighter), 4);
  assert.notEqual(color(brighter), color(initial));
  assert.equal(animation.update(frame(10_000 + 5 * CURSOR_FRAME_INTERVAL_MS, 4 / 8)), brighter);
  assert.equal(color(animation.update(frame(14_000, 4 / 8))), color(initial));
});

test("extra host samples do not accelerate either clock", () => {
  const sparse = new CursorAnimation();
  const dense = new CursorAnimation();
  sparse.update(frame(0));
  dense.update(frame(0));
  for (let tick = 1; tick <= 12; tick++) {
    const nowMs = tick * CURSOR_FRAME_INTERVAL_MS;
    const level = (tick % 8 + 1) / 8;
    for (const offset of [12, 8, 4]) dense.update(frame(nowMs - offset, level));
    assert.deepEqual(dense.update(frame(nowMs, level)), sparse.update(frame(nowMs, level)));
  }
});

test("silent tails turn gray immediately and settled silence produces no redraw frames", () => {
  const animation = new CursorAnimation();
  animation.update(frame(0, 1));
  const gray = animation.update(frame(1, 1, { active: false }));
  assert.equal(height(gray), 8);
  assert.equal(color(gray), "\x1b[38;2;128;128;128m");
  const tail = animation.update(frame(CURSOR_FRAME_INTERVAL_MS, 0.5, { active: false }));
  assert.equal(height(tail), 4);
  assert.equal(color(tail), color(gray));
  const settled = animation.update(frame(2 * CURSOR_FRAME_INTERVAL_MS, 0, { active: false }));
  for (const nowMs of [100, 1_000, 2_000, 4_000]) {
    assert.equal(animation.update(frame(nowMs, 0, { active: false })), settled);
  }
  const resumed = animation.update(frame(4_001, 0, { active: true }));
  assert.equal(color(resumed), "\x1b[38;2;224;82;82m");
});

test("hue continues through silence rather than restarting at voice onset", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(3_000, 1));
  animation.update(frame(3_100, 0, { active: false }));
  const resumed = animation.update(frame(5_000, 0.5));
  assert.notEqual(color(resumed), color(initial));
  assert.equal(color(resumed), "\x1b[38;2;82;224;224m");
});

test("invalid and backwards clocks hold motion and recover on monotonic time", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(1_000, 0.5));
  for (const nowMs of [NaN, Infinity, -Infinity, 999, -1]) {
    assert.equal(animation.update(frame(nowMs, 1)), initial);
  }
  const advanced = animation.update(frame(1_000 + CURSOR_FRAME_INTERVAL_MS, 1));
  assert.equal(height(advanced), 8);
  assert.equal(animation.update(frame(1_001, 0)), advanced);
  assert.equal(height(animation.update(frame(1_000 + 2 * CURSOR_FRAME_INTERVAL_MS, 0))), 1);
  const untimed = new CursorAnimation();
  assert.equal(height(untimed.update(frame(NaN, 0.5))), 4);
  assert.equal(height(untimed.update(frame(500, 1))), 8);
});

test("long stalls consume the current smoothed signal without replay or artificial lag", () => {
  const animation = new CursorAnimation();
  animation.update(frame(0, 0));
  const loud = animation.update(frame(5_000, 1));
  assert.equal(height(loud), 8);
  assert.equal(animation.update(frame(5_001, 0)), loud);
  assert.equal(height(animation.update(frame(5_000 + CURSOR_FRAME_INTERVAL_MS, 0))), 1);
});

test("state and reduced-motion toggles bypass caching and never retain stale height", () => {
  const animation = new CursorAnimation();
  animation.update(frame(10_000, 1));
  const transcribing = animation.update(frame(10_001, 0, { state: "transcribing" }));
  assert.equal(height(transcribing), 4);
  assert.equal(animation.update(frame(12_000, 1, { state: "transcribing", active: false })), transcribing);
  const recording = animation.update(frame(12_001, 1 / 8));
  assert.equal(height(recording), 1);
  assert.equal(recording.nowMs, 0);
  const reduced = animation.update(frame(12_002, 1, { reducedMotion: true }));
  assert.equal(height(reduced), 6);
  assert.equal(animation.update(frame(13_000, 0, { reducedMotion: true, active: false })), reduced);
  const moving = animation.update(frame(14_001, 3 / 8));
  assert.equal(height(moving), 3);
  assert.equal(color(moving), "\x1b[38;2;82;224;224m");
});

test("color preference and activity changes apply immediately without advancing height", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(0, 2 / 8));
  const monochrome = animation.update(frame(1, 1, { color: false }));
  assert.equal(monochrome.level, initial.level);
  assert.equal(paint(monochrome).replace(CURSOR_MARKER, "").includes("\x1b"), false);
  const colored = animation.update(frame(2, 1));
  assert.equal(colored.level, initial.level);
  assert.equal(color(colored), color(initial));
  const silent = animation.update(frame(3, 1, { active: false }));
  assert.equal(silent.level, initial.level);
  assert.equal(color(silent), "\x1b[38;2;128;128;128m");
});

test("monochrome stable heights do not redraw for an invisible color clock", () => {
  const animation = new CursorAnimation();
  const initial = animation.update(frame(0, 0.5, { color: false }));
  assert.equal(animation.update(frame(1_000, 0.5, { color: false })), initial);
  const colored = animation.update(frame(1_001, 0.5));
  assert.notEqual(color(colored), "\x1b[38;2;224;82;82m");
});

test("reset removes amplitude, session hue phase and presentation mode", () => {
  const animation = new CursorAnimation();
  animation.update(frame(1_000, 1));
  animation.update(frame(3_000, 1));
  animation.reset();
  const restarted = animation.update(frame(20_000, 1 / 8));
  assert.equal(height(restarted), 1);
  assert.equal(restarted.nowMs, 0);
  assert.equal(color(restarted), "\x1b[38;2;224;82;82m");
  animation.update(frame(20_001, 1, { reducedMotion: true }));
  animation.reset();
  assert.equal(height(animation.update(frame(0, 2 / 8))), 2);
});

test("all rendered frames remain one bounded glyph without leaking terminal controls", () => {
  const animation = new CursorAnimation();
  for (let index = 0; index < 120; index++) {
    const presentation = animation.update(frame(index * CURSOR_FRAME_INTERVAL_MS, (index % 9) / 8, { active: index % 3 !== 0 }));
    const rendered = paint(presentation);
    assert.equal(visibleWidth(rendered), 1);
    assert.match(stripTerminalSequences(rendered).replace(CURSOR_MARKER, ""), /^[▁▂▃▄▅▆▇█]$/u);
    assert.equal(rendered.replace(CURSOR_MARKER, "").replace(/\x1b\[38;2;\d+;\d+;\d+m/g, "").replace(/\x1b\[39m/g, "").includes("\x1b"), false);
  }
});
