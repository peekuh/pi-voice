import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CursorCellOutput, type CursorOutputFrame } from "../src/cursor-output.ts";

const begin = "\x1b[?2026h";
const end = "\x1b[?2026l";
const reset = "\x1b[0m\x1b]8;;\x07";
const oldPaint = "\x1b[38;2;94;211;139m▁\x1b[39m";
const newPaint = "\x1b[38;2;72;199;210m█\x1b[39m";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function native(writes: [number, string][], row = 2, column = 4): string {
  return begin + writes.map(([index, text]) => `\x1b[${index};1H\x1b[2K${text}${reset}`).join("")
    + `\x1b[${row};${column}H\x1b[?25l` + end;
}

interface Style {
  foreground: string;
  background: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  link: string;
}

interface Cell {
  text: string;
  style: Style;
}

function defaultStyle(): Style {
  return { foreground: "default", background: "default", bold: false, italic: false,
    underline: false, inverse: false, link: "" };
}

class TerminalGrid {
  columns: number;
  rows: number;
  cells: Cell[][];
  row = 0;
  column = 0;
  hidden = true;
  synchronized = false;
  style = defaultStyle();

  constructor(columns = 40, rows = 6) {
    this.columns = columns;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: columns },
      () => ({ text: " ", style: defaultStyle() })));
  }

  private sgr(parameters: string): void {
    const values = parameters === "" ? [0] : parameters.split(";").map(Number);
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (value === 0) this.style = { ...defaultStyle(), link: this.style.link };
      else if (value === 1) this.style.bold = true;
      else if (value === 22) this.style.bold = false;
      else if (value === 3) this.style.italic = true;
      else if (value === 23) this.style.italic = false;
      else if (value === 4) this.style.underline = true;
      else if (value === 24) this.style.underline = false;
      else if (value === 7) this.style.inverse = true;
      else if (value === 27) this.style.inverse = false;
      else if (value === 39) this.style.foreground = "default";
      else if (value === 49) this.style.background = "default";
      else if (value === 38 || value === 48) {
        const count = values[index + 1] === 2 ? 4 : 2;
        const color = values.slice(index + 1, index + 1 + count).join(";");
        if (value === 38) this.style.foreground = color;
        else this.style.background = color;
        index += count;
      } else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
        this.style.foreground = String(value);
      } else if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) {
        this.style.background = String(value);
      } else assert.fail(`unimplemented fixture SGR ${value}`);
    }
  }

  write(data: string): void {
    let offset = 0;
    while (offset < data.length) {
      const rest = data.slice(offset);
      const csi = /^\x1b\[([\d;?]*)([A-Za-z])/.exec(rest);
      if (csi !== null) {
        const [, parameters, command] = csi;
        if (command === "H") {
          const [row, column] = parameters.split(";").map(Number);
          this.row = (row || 1) - 1;
          this.column = (column || 1) - 1;
        } else if (command === "K" && parameters === "2") {
          this.cells[this.row] = Array.from({ length: this.columns }, () => ({ text: " ", style: { ...this.style } }));
        } else if (command === "J" && parameters === "2") {
          this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.columns },
            () => ({ text: " ", style: { ...this.style } })));
        } else if (command === "m") this.sgr(parameters);
        else if (parameters === "?25") this.hidden = command === "l";
        else if (parameters === "?2026") this.synchronized = command === "h";
        else assert.fail(`unimplemented fixture CSI ${csi[0]}`);
        offset += csi[0].length;
        continue;
      }
      const link = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(rest);
      if (link !== null) {
        this.style.link = link[1];
        offset += link[0].length;
        continue;
      }
      assert.notEqual(rest[0], "\x1b", `unexpected fixture escape at ${offset}`);
      const escape = rest.indexOf("\x1b");
      const text = escape === -1 ? rest : rest.slice(0, escape);
      for (const { segment } of segmenter.segment(text)) {
        const width = visibleWidth(segment);
        assert.ok(width > 0 && this.column + width <= this.columns, `fixture cell overflow: ${segment}`);
        for (let cell = 0; cell < width; cell++) {
          this.cells[this.row][this.column + cell] = { text: cell === 0 ? segment : "", style: { ...this.style } };
        }
        this.column += width;
      }
      offset += text.length;
    }
  }
}

class Comparison {
  output = new CursorCellOutput();
  original = new TerminalGrid();
  rewritten = new TerminalGrid();

  constructor() {
    this.draw(native([[1, ""]]));
  }

  draw(data: string, paint: string | null = oldPaint, dimensions = { columns: 40, rows: 6 }): string {
    const frame: CursorOutputFrame | undefined = paint === null ? undefined : { paint, ...dimensions };
    const result = this.output.rewrite(data, frame);
    this.original.write(data);
    this.rewritten.write(result);
    assert.deepEqual(this.rewritten, this.original, "rewriting must preserve every cell, caret, style, hyperlink and mode");
    return result;
  }
}

test("steady animation changes glyph and color with no row clears and identical terminal state", () => {
  const comparison = new Comparison();
  const initial = native([[2, `abc${oldPaint} tail`]]);
  assert.equal(comparison.draw(initial), initial);
  for (let index = 0; index < 24; index++) {
    const paint = `\x1b[38;2;${index};${255 - index};100m${"▁▂▃▄▅▆▇█"[index % 8]}\x1b[39m`;
    const result = comparison.draw(native([[2, `abc${paint} tail`]]), paint);
    assert.ok(!result.includes("\x1b[2K"));
    assert.equal(comparison.original.cells[1][3].text, "▁▂▃▄▅▆▇█"[index % 8]);
  }
});

test("inherited SGR and hyperlink wrappers are reconstructed without style leakage", () => {
  const comparison = new Comparison();
  const prefix = "\x1b[1;3;4;7;48;2;20;40;60m\x1b]8;id=fixture;https://example.test/\x1b\\abc";
  const suffix = "\x1b[22;23;24;27;49m\x1b]8;;\x07\x1b[34m suffix\x1b[39m";
  comparison.draw(native([[2, prefix + oldPaint + suffix]]));
  const result = comparison.draw(native([[2, prefix + newPaint + suffix]]), newPaint);
  assert.ok(!result.includes("\x1b[2K"));
  assert.equal(comparison.rewritten.cells[1][3].style.background, "2;20;40;60");
  assert.equal(comparison.rewritten.cells[1][3].style.link, "https://example.test/");
  assert.deepEqual(comparison.rewritten.style, defaultStyle());
  assert.equal(comparison.rewritten.cells[1][5].style.foreground, "34");
});

test("display columns handle wide and combining text and preserve wide-grapheme cursor padding", () => {
  for (const prefix of ["界e\u0301", "👩‍💻a", "a界", "e\u0301bc"]) {
    const comparison = new Comparison();
    const initial = native([[2, prefix + oldPaint + "  suffix"]]);
    comparison.draw(initial);
    const result = comparison.draw(native([[2, prefix + newPaint + "  suffix"]]), newPaint);
    assert.ok(!result.includes("\x1b[2K"));
    assert.equal(comparison.rewritten.cells[1][4].text, " ");
    assert.equal(comparison.rewritten.cells[1][5].text, " ");
  }
});

test("other changed rows and all non-target frame bytes remain intact", () => {
  const comparison = new Comparison();
  comparison.draw(native([[1, "header"], [2, `abc${oldPaint} tail`], [4, "footer"]]));
  const next = native([[1, "new header"], [2, `abc${newPaint} tail`], [4, "new footer"]]);
  const result = comparison.draw(next, newPaint);
  assert.ok(result.startsWith(begin + `\x1b[1;1H\x1b[2Knew header${reset}`));
  assert.ok(result.includes(`\x1b[4;1H\x1b[2Knew footer${reset}`));
  assert.equal(result.match(/\x1b\[2K/g)?.length, 2);
});

test("text changes pass through and establish the next complete row baseline", () => {
  const comparison = new Comparison();
  comparison.draw(native([[2, `abc${oldPaint} tail`]]));
  const changed = native([[2, `abc${newPaint} changed`]]);
  assert.equal(comparison.draw(changed, newPaint), changed);
  const result = comparison.draw(native([[2, `abc${oldPaint} changed`]]));
  assert.ok(!result.includes("\x1b[2K"));
});

test("zero-row frames and unrelated rows preserve an unchanged caret-row baseline", () => {
  const comparison = new Comparison();
  comparison.draw(native([[2, `abc${oldPaint}`]]));
  const empty = native([]);
  assert.equal(comparison.draw(empty), empty);
  comparison.draw(native([[4, "other content"]]));
  const result = comparison.draw(native([[2, `abc${newPaint}`]]), newPaint);
  assert.ok(!result.includes("\x1b[2K"));
});

test("NO_COLOR cursor cells optimize without adding a foreground color", () => {
  const comparison = new Comparison();
  comparison.draw(native([[2, "abc▁ suffix"]]), "▁");
  const result = comparison.draw(native([[2, "abc█ suffix"]]), "█");
  assert.ok(!result.includes("\x1b[2K"));
  assert.ok(!result.includes("38;"));
});

test("caret relocation invalidates and requires a fresh full-row baseline", () => {
  const comparison = new Comparison();
  comparison.draw(native([[2, `abc${oldPaint}`]]));
  const moved = native([[2, `abcd${newPaint}`]], 2, 5);
  assert.equal(comparison.draw(moved, newPaint), moved);
  const baseline = native([[2, `abcd${oldPaint}`]], 2, 5);
  assert.equal(comparison.draw(baseline), baseline);
  assert.ok(!comparison.draw(native([[2, `abcd${newPaint}`]], 2, 5), newPaint).includes("\x1b[2K"));
});

test("resizing, full redraw, visible caret, and explicit reset invalidate the baseline", () => {
  for (const invalidation of ["resize", "clear", "visible", "reset"]) {
    const comparison = new Comparison();
    comparison.draw(native([[2, `abc${oldPaint}`]]));
    const update = native([[2, `abc${newPaint}`]]);
    if (invalidation === "resize") assert.equal(comparison.draw(update, newPaint, { columns: 39, rows: 6 }), update);
    if (invalidation === "clear") {
      const clear = update.replace(begin, begin + "\x1b[2J");
      assert.equal(comparison.draw(clear, newPaint), clear);
    }
    if (invalidation === "visible") {
      const visible = update.replace("\x1b[?25l", "\x1b[?25h");
      assert.equal(comparison.draw(visible, newPaint), visible);
    }
    if (invalidation === "reset") comparison.output.reset();
    comparison.draw(native([[1, "recovery"]]));
    const baseline = native([[2, `abc${oldPaint}`]]);
    assert.equal(comparison.draw(baseline), baseline);
    assert.ok(!comparison.draw(update, newPaint).includes("\x1b[2K"));
  }
});

test("focus-off and cancellation final redraw are never narrowed", () => {
  const comparison = new Comparison();
  comparison.draw(native([[2, `abc${oldPaint} tail`]]));
  const final = native([[2, "abcfinal transcription tail"]]);
  assert.equal(comparison.draw(final, null), final);
  comparison.draw(native([[1, "recovery"]]));
  const initial = native([[2, `abc${oldPaint} tail`]]);
  assert.equal(comparison.draw(initial), initial);
  assert.ok(!comparison.draw(native([[2, `abc${newPaint} tail`]]), newPaint).includes("\x1b[2K"));
});

test("unknown inherited background cannot contaminate a recovered cursor-row baseline", () => {
  const comparison = new Comparison();
  comparison.draw(native([[2, `abc${oldPaint} suffix`]]));
  comparison.draw("\x1b[41m");
  const recovery = native([[2, `abc${newPaint} suffix`]]);
  assert.equal(comparison.draw(recovery, newPaint), recovery);
  assert.equal(comparison.rewritten.cells[1][0].style.background, "41");
  const baseline = native([[2, `abc${oldPaint} suffix`]]);
  assert.equal(comparison.draw(baseline), baseline);
  assert.equal(comparison.rewritten.cells[1][0].style.background, "default");
  assert.ok(!comparison.draw(recovery, newPaint).includes("\x1b[2K"));
});

test("unknown, partial, scrolling, image, OSC and unsupported formats pass through and invalidate", () => {
  const initial = native([[2, `abc${oldPaint}`]]);
  const update = native([[2, `abc${newPaint}`]]);
  const unknowns = [
    "unframed output", "\x1b[1S", begin, update.slice(0, -1), update + "\n",
    update.replace(begin, begin + "\x1b[H"),
    update.replace(begin, begin + "\x1b[2J"),
    update.replace(begin, begin + "\x1b_Ga=T;image\x1b\\"),
    update.replace("abc", "\x1b]1337;File=payload\x07abc"),
    update.replace("abc", "\x1b]0;title\x07abc"),
    update.replace("abc", "\x1b[999mabc"),
    update.replace("abc", "\x1b[38:2::1:2:3mabc"),
    update.replace("abc", "a\tbc"),
    update.replace(reset, ""),
    native([[2, `abc${newPaint}`], [2, "duplicate row"]]),
    native([[3, "out of order"], [2, `abc${newPaint}`]]),
  ];
  for (const unknown of unknowns) {
    const output = new CursorCellOutput();
    output.rewrite(initial, { paint: oldPaint, columns: 40, rows: 6 });
    assert.equal(output.rewrite(unknown, { paint: newPaint, columns: 40, rows: 6 }), unknown);
    assert.equal(output.rewrite(update, { paint: newPaint, columns: 40, rows: 6 }), update,
      "unknown writes must discard even a formerly valid row snapshot");
  }
});

test("missing, wrong-column, combining and ambiguous slots are not optimized", () => {
  const initial = native([[2, `abc${oldPaint}`]]);
  for (const row of ["abcno cursor", `ab${newPaint}`, `abcd${newPaint}`, `abc${newPaint}\u0301`,
    `abc${newPaint}\u200d█`, `abc${newPaint}\x1b[0G${newPaint}`]) {
    const output = new CursorCellOutput();
    output.rewrite(initial, { paint: oldPaint, columns: 40, rows: 6 });
    const update = native([[2, row]]);
    assert.equal(output.rewrite(update, { paint: newPaint, columns: 40, rows: 6 }), update);
    assert.equal(output.rewrite(initial, { paint: oldPaint, columns: 40, rows: 6 }), initial);
  }
});

test("malformed paint and dimensions invalidate without changing any bytes", () => {
  const initial = native([[2, `abc${oldPaint}`]]);
  for (const paint of ["", " ", "██", "x", "█\n", "\x1b[31m█\x1b[39m",
    "\x1b[38;2;256;0;0m█\x1b[39m", "\x1b[38;2;1;2;3m█", "█\x1b[2J"]) {
    const output = new CursorCellOutput();
    output.rewrite(initial, { paint: oldPaint, columns: 40, rows: 6 });
    assert.equal(output.rewrite(initial, { paint, columns: 40, rows: 6 }), initial);
    assert.equal(output.rewrite(initial, { paint: oldPaint, columns: 40, rows: 6 }), initial);
  }
  for (const dimensions of [{ columns: 0, rows: 6 }, { columns: 40, rows: NaN },
    { columns: Infinity, rows: 6 }, { columns: 40.5, rows: 6 }, { columns: 2, rows: 1 }]) {
    const output = new CursorCellOutput();
    assert.equal(output.rewrite(initial, { paint: oldPaint, ...dimensions }), initial);
  }
});
