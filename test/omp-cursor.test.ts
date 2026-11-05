import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { paintOmpCursor } from "../src/omp-cursor.ts";
import type { VoiceCursorFrame } from "../src/cursor-style.ts";

const marker = "\x1b_pi:c\x07";
const metrics = { marker, visibleWidth };
const frame: VoiceCursorFrame = {
  state: "recording",
  level: 1,
  nowMs: 0,
  reducedMotion: false,
  color: true,
};

test("native middle cursor preserves caret column, suffix, width and other rows", () => {
  const before = "│ prefix: ";
  const after = " suffix │";
  const input = Object.freeze(["first row", before + marker + "x" + after, "last row"]);
  const result = paintOmpCursor(input, frame, metrics);
  assert.notEqual(result, input);
  assert.equal(result[0], input[0]);
  assert.equal(result[2], input[2]);
  assert.ok(result[1].startsWith(before + marker));
  assert.ok(result[1].endsWith(after));
  assert.equal(visibleWidth(result[1]), visibleWidth(input[1]));
  assert.equal(visibleWidth(result[1].slice(0, result[1].indexOf(marker))), visibleWidth(before));
  assert.equal(result[1].split(marker).length, 2);
  assert.equal(stripTerminalSequences(result[1]), before + "█" + after);
  assert.equal(input[1], before + marker + "x" + after);
});

for (const grapheme of ["e\u0301", "界", "🙂", "👩‍💻", " "]) {
  test(`native marker paint preserves the display width of ${JSON.stringify(grapheme)}`, () => {
    const input = "before" + marker + grapheme + "SUFFIX";
    const result = paintOmpCursor([input], frame, metrics)[0];
    assert.equal(visibleWidth(result), visibleWidth(input));
    assert.equal(stripTerminalSequences(result), "before█" + " ".repeat(visibleWidth(grapheme) - 1) + "SUFFIX");
    assert.ok(result.endsWith("SUFFIX"));
    assert.equal(result.indexOf(marker), input.indexOf(marker));
  });
}

for (const foreground of ["\x1b[31m", "\x1b[38;5;180m", "\x1b[38;2;10;20;30m", "\x1b[38:2::10:20:30m"]) {
  test(`native paint restores the inherited foreground ${JSON.stringify(foreground)}`, () => {
    const input = "\x1b[1;44m" + foreground + "before" + marker + "x suffix\x1b[0m";
    const result = paintOmpCursor([input], frame, metrics)[0];
    assert.ok(result.includes("\x1b[38;2;94;211;139m█" + foreground + " suffix\x1b[0m"));
    assert.ok(result.startsWith("\x1b[1;44m" + foreground + "before" + marker));
    assert.equal(visibleWidth(result), visibleWidth(input));
  });
}

test("native paint preserves zero-width styles and hyperlink controls at the caret", () => {
  const open = "\x1b]8;;https://example.com\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  const before = "prefix" + marker + "\x1b[32m" + open;
  const after = close + "\x1b[39m suffix";
  const input = before + "x" + after;
  const result = paintOmpCursor([input], frame, metrics)[0];
  assert.ok(result.startsWith(before));
  assert.ok(result.endsWith("\x1b[32m" + after));
  assert.equal(visibleWidth(result), visibleWidth(input));
  assert.equal(stripTerminalSequences(result), "prefix█ suffix");
});

test("no-color paint introduces no SGR and finalizing uses a steady block", () => {
  const input = "prefix" + marker + "x suffix";
  const result = paintOmpCursor([input], { ...frame, color: false, state: "transcribing" }, metrics)[0];
  assert.equal(result, "prefix" + marker + "▄ suffix");
});

test("unknown controls and missing marker or grapheme pass through without mutation", () => {
  for (const line of ["ordinary text", "prefix" + marker, "prefix" + marker + "\x1b[2Kx", "prefix" + marker + "\n"]) {
    const input = Object.freeze([line]);
    assert.equal(paintOmpCursor(input, frame, metrics), input);
  }
});
