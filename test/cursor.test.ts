import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, renderFakeCursor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderVoiceCursor } from "../src/cursor.ts";
import type { VoiceCursorFrame } from "../src/cursor-style.ts";

const frame: VoiceCursorFrame = {
  state: "recording",
  level: 0,
  nowMs: 0,
  reducedMotion: false,
  color: true,
};

function render(overrides: Partial<VoiceCursorFrame> = {}, character = " "): string {
  return renderVoiceCursor([CURSOR_MARKER + renderFakeCursor(character)], { ...frame, ...overrides })[0];
}

function glyph(line: string): string {
  const match = stripTerminalSequences(line).match(/[▁▂▃▄▅▆▇█]/u);
  assert.ok(match, "a lower-block cursor is visible");
  return match[0];
}

function color(line: string): string {
  const match = line.match(/\x1b\[38;2;\d+;\d+;\d+m/);
  assert.ok(match, "the cursor has a truecolor foreground");
  return match[0];
}

test("recording immediately maps quiet through loud audio to bounded block heights", () => {
  assert.equal(glyph(render({ level: 0 })), "▁");
  assert.equal(glyph(render({ level: 1 })), "█");
  const levels = [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1];
  assert.equal(levels.map((level) => glyph(render({ level }))).join(""), "▁▂▃▄▅▆▇█");
  for (const level of [-1, -Infinity, NaN]) assert.equal(glyph(render({ level })), "▁");
  for (const level of [2, Infinity]) assert.equal(glyph(render({ level })), "█");
});

test("recording color changes smoothly over time and repeats after eight seconds", () => {
  const first = color(render({ nowMs: 0 }));
  assert.notEqual(color(render({ nowMs: 2_000 })), first);
  assert.notEqual(color(render({ nowMs: 4_000 })), first);
  assert.equal(color(render({ nowMs: 8_000 })), first);
  const before = color(render({ nowMs: 1_333 })).match(/\d+/g)!.slice(2).map(Number);
  const after = color(render({ nowMs: 1_334 })).match(/\d+/g)!.slice(2).map(Number);
  assert.ok(before.every((channel, index) => Math.abs(channel - after[index]) <= 1));
  assert.equal(glyph(render({ nowMs: 4_000, level: 0.5 })), glyph(render({ nowMs: 0, level: 0.5 })));
});

test("transcribing stays muted and steady regardless of sound and time", () => {
  const quiet = render({ state: "transcribing", level: 0, nowMs: 0 });
  const loud = render({ state: "transcribing", level: 1, nowMs: 6_000 });
  assert.equal(glyph(quiet), glyph(loud));
  assert.equal(color(quiet), color(loud));
  assert.notEqual(color(quiet), color(render()));
});

test("reduced motion fixes recording height and color while distinguishing finalizing", () => {
  const quiet = render({ reducedMotion: true, level: 0, nowMs: 0 });
  const loud = render({ reducedMotion: true, level: 1, nowMs: 6_000 });
  const finalizing = render({ reducedMotion: true, state: "transcribing" });
  assert.equal(glyph(quiet), glyph(loud));
  assert.equal(color(quiet), color(loud));
  assert.notEqual(glyph(quiet), glyph(finalizing));
  assert.notEqual(color(quiet), color(finalizing));
});

test("no-color emits no new color controls in every state and motion mode", () => {
  for (const state of ["recording", "transcribing"] as const) {
    for (const reducedMotion of [false, true]) {
      const result = render({ state, reducedMotion, color: false, level: 1 });
      assert.equal(result.replace(CURSOR_MARKER, "").includes("\x1b"), false);
      assert.equal(visibleWidth(result), 1);
    }
  }
  const recording = render({ color: false, reducedMotion: true });
  const finalizing = render({ color: false, reducedMotion: true, state: "transcribing" });
  assert.notEqual(glyph(recording), glyph(finalizing));
});

test("the wrapped rendered caret preserves prefix, suffix, marker column and unrelated rows", () => {
  const prefix = "│ wrapped continuation: ";
  const suffix = " remaining text │";
  const input = Object.freeze([
    "first logical line has wrapped",
    prefix + CURSOR_MARKER + renderFakeCursor("x") + suffix,
    "last row",
  ]);
  const result = renderVoiceCursor(input, frame);
  assert.notEqual(result, input);
  assert.equal(result[0], input[0]);
  assert.equal(result[2], input[2]);
  assert.ok(result[1].startsWith(prefix + CURSOR_MARKER));
  assert.ok(result[1].endsWith(suffix));
  assert.equal(visibleWidth(result[1]), visibleWidth(input[1]));
  assert.equal(visibleWidth(result[1].slice(0, result[1].indexOf(CURSOR_MARKER))), visibleWidth(prefix));
  assert.ok(input[1].includes(renderFakeCursor("x")), "the readonly input is unchanged");
});

for (const character of ["界", "🙂", "👩‍💻", "e\u0301", " "]) {
  test(`caret replacement preserves ${JSON.stringify(character)} grapheme width and suffix column`, () => {
    const suffix = "SUFFIX";
    const input = "before " + CURSOR_MARKER + renderFakeCursor(character) + suffix;
    const result = renderVoiceCursor([input], { ...frame, color: false })[0];
    assert.equal(visibleWidth(result), visibleWidth(input));
    const suffixColumn = visibleWidth(result.slice(0, result.indexOf(suffix)));
    assert.equal(suffixColumn, visibleWidth("before ") + visibleWidth(character));
    assert.ok(result.endsWith(suffix));
    assert.equal(visibleWidth(result.slice(result.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length, result.indexOf(suffix))), visibleWidth(character));
  });
}

test("only the native fake cursor immediately following the focused marker is replaced", () => {
  const unfocused = renderFakeCursor("a");
  const later = renderFakeCursor("b");
  const input = unfocused + " prefix " + CURSOR_MARKER + renderFakeCursor("c") + " suffix " + later;
  const result = renderVoiceCursor([input], frame)[0];
  assert.ok(result.startsWith(unfocused + " prefix " + CURSOR_MARKER));
  assert.ok(result.endsWith(" suffix " + later));
  assert.equal(result.split(CURSOR_MARKER).length - 1, 1);
  assert.equal(visibleWidth(result), visibleWidth(input));
});

test("absent, unfocused, detached and zero-width cursor slots return the original lines", () => {
  const probe = "probe";
  const wrapped = renderFakeCursor(probe);
  const end = wrapped.slice(wrapped.indexOf(probe) + probe.length);
  for (const input of [
    [],
    ["plain text"],
    [renderFakeCursor("x")],
    [CURSOR_MARKER + "text"],
    [CURSOR_MARKER + "gap" + renderFakeCursor("x")],
    [CURSOR_MARKER + renderFakeCursor("x").slice(0, -end.length)],
    [CURSOR_MARKER + renderFakeCursor("")],
  ]) {
    Object.freeze(input);
    assert.equal(renderVoiceCursor(input, frame), input);
  }
});

test("cursor color restores an existing foreground without altering surrounding styling", () => {
  for (const foreground of ["\x1b[31m", "\x1b[94m", "\x1b[38;5;123m", "\x1b[38;2;11;22;33m", "\x1b[38:2::11:22:33m"]) {
    const prefix = foreground + "before ";
    const suffix = "after\x1b[0m";
    const input = prefix + CURSOR_MARKER + renderFakeCursor("x") + suffix;
    const result = renderVoiceCursor([input], frame)[0];
    assert.ok(result.startsWith(prefix + CURSOR_MARKER));
    assert.ok(result.endsWith(foreground + suffix));
    assert.equal(visibleWidth(result), visibleWidth(input));
    const uncolored = renderVoiceCursor([input], { ...frame, color: false })[0];
    assert.ok(uncolored.startsWith(prefix + CURSOR_MARKER));
    assert.ok(uncolored.endsWith(suffix));
    assert.equal((uncolored.match(/\x1b\[/g) ?? []).length, (input.match(/\x1b\[/g) ?? []).length);
  }
});
