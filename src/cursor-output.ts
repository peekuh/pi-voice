import { visibleWidth } from "@earendil-works/pi-tui";

export interface CursorOutputFrame {
  paint: string;
  columns: number;
  rows: number;
}

interface CaretRow {
  row: number;
  column: number;
  columns: number;
  rows: number;
  text: string;
  paint: string;
}

interface Control {
  start: number;
  end: number;
  text: string;
}

interface RowWrite {
  row: number;
  start: number;
  end: number;
  text: string;
  controls: Control[];
}

interface NativeFrame {
  row: number;
  column: number;
  writes: RowWrite[];
}

const begin = "\x1b[?2026h";
const rowReset = "\x1b[0m\x1b]8;;\x07";
const paintPattern = /^(?:[▁▂▃▄▅▆▇█]|\x1b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m[▁▂▃▄▅▆▇█]\x1b\[39m)$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function validPaint(paint: string): boolean {
  const match = paintPattern.exec(paint);
  return match !== null && match[0].length === paint.length
    && match.slice(1).every((channel) => channel === undefined || Number(channel) <= 255);
}

function validSgr(parameters: string): boolean {
  if (parameters === "") return true;
  const values = parameters.split(";");
  for (let index = 0; index < values.length; index++) {
    if (!/^\d{1,3}$/.test(values[index])) return false;
    const value = Number(values[index]);
    if (value === 38 || value === 48 || value === 58) {
      const mode = values[++index];
      const count = mode === "2" ? 3 : mode === "5" ? 1 : -1;
      if (count === -1) return false;
      for (let channel = 0; channel < count; channel++) {
        const component = values[++index];
        if (component === undefined || !/^\d{1,3}$/.test(component) || Number(component) > 255) return false;
      }
    } else if (!(value <= 9 || (value >= 21 && value <= 29) || (value >= 30 && value <= 37)
      || value === 39 || (value >= 40 && value <= 47) || value === 49 || value === 53
      || value === 55 || value === 59 || (value >= 90 && value <= 97) || (value >= 100 && value <= 107))) {
      return false;
    }
  }
  return true;
}

function rowControls(text: string): Control[] | undefined {
  if (!text.endsWith(rowReset)) return undefined;
  const controls: Control[] = [];
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const remainder = text.slice(index);
      const sgr = /^\x1b\[([\d;]*)m/.exec(remainder);
      const hyperlink = /^\x1b\]8;[^\x00-\x1f\x7f-\x9f;]*;[^\x00-\x1f\x7f-\x9f]*(?:\x07|\x1b\\)/.exec(remainder);
      const sequence = sgr && validSgr(sgr[1]) ? sgr[0] : hyperlink?.[0];
      if (sequence === undefined) return undefined;
      controls.push({ start: index, end: index + sequence.length, text: sequence });
      index += sequence.length;
    } else {
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return undefined;
      index++;
    }
  }
  return controls;
}

function parseFrame(data: string, frame: CursorOutputFrame): NativeFrame | undefined {
  if (!data.startsWith(begin)) return undefined;
  const suffix = /\x1b\[([1-9]\d*);([1-9]\d*)H\x1b\[\?25l\x1b\[\?2026l$/.exec(data);
  if (suffix === null || suffix.index + suffix[0].length !== data.length) return undefined;
  const row = Number(suffix[1]);
  const column = Number(suffix[2]);
  if (row > frame.rows || column > frame.columns) return undefined;
  const bodyEnd = suffix.index;
  const writes: RowWrite[] = [];
  const header = /\x1b\[([1-9]\d*);1H\x1b\[2K/g;
  let offset = begin.length;
  let previousRow = 0;
  while (offset < bodyEnd) {
    header.lastIndex = offset;
    const match = header.exec(data);
    if (match === null || match.index !== offset) return undefined;
    const writeRow = Number(match[1]);
    if (writeRow <= previousRow || writeRow > frame.rows) return undefined;
    previousRow = writeRow;
    const textStart = header.lastIndex;
    const next = header.exec(data);
    const textEnd = next !== null && next.index < bodyEnd ? next.index : bodyEnd;
    const text = data.slice(textStart, textEnd);
    const controls = rowControls(text);
    if (controls === undefined || visibleWidth(text) > frame.columns) return undefined;
    writes.push({ row: writeRow, start: offset, end: textEnd, text, controls });
    offset = textEnd;
  }
  return { row, column, writes };
}

function slot(write: RowWrite, paint: string, column: number): number | undefined {
  let found: number | undefined;
  let offset = write.text.indexOf(paint);
  while (offset !== -1) {
    const paintEnd = offset + paint.length;
    const cutsControl = write.controls.some((control) => (control.start < offset && offset < control.end)
      || (control.start < paintEnd && paintEnd < control.end));
    if (!cutsControl && visibleWidth(write.text.slice(0, offset)) === column - 1) {
      const plainPrefix = write.text.slice(0, offset).replace(/\x1b\[[\d;]*m|\x1b\]8;[^\x00-\x1f\x7f-\x9f;]*;[^\x00-\x1f\x7f-\x9f]*(?:\x07|\x1b\\)/g, "");
      let plain = "";
      let start = 0;
      for (const control of write.controls) {
        plain += write.text.slice(start, control.start);
        start = control.end;
      }
      plain += write.text.slice(start);
      const glyph = paint.replace(/\x1b\[[\d;]*m/g, "");
      for (const segment of graphemes.segment(plain)) {
        if (segment.index === plainPrefix.length && segment.segment === glyph) {
          if (found !== undefined) return undefined;
          found = offset;
          break;
        }
      }
    }
    offset = write.text.indexOf(paint, offset + 1);
  }
  return found;
}

export class CursorCellOutput {
  private previous: CaretRow | undefined;
  private defaultState = false;

  reset(): void {
    this.previous = undefined;
    this.defaultState = false;
  }

  rewrite(data: string, frame: CursorOutputFrame | undefined): string {
    if (frame === undefined || !validPaint(frame.paint) || !Number.isSafeInteger(frame.columns)
      || !Number.isSafeInteger(frame.rows) || frame.columns < 1 || frame.rows < 1) {
      this.reset();
      return data;
    }
    const previous = this.previous;
    const native = parseFrame(data, frame);
    if (native === undefined) {
      this.reset();
      return data;
    }
    const safeStart = this.defaultState;
    if (native.writes.length > 0) this.defaultState = true;
    if (previous !== undefined && (previous.columns !== frame.columns || previous.rows !== frame.rows
      || previous.row !== native.row || previous.column !== native.column)) {
      this.previous = undefined;
      return data;
    }
    if (!safeStart) return data;
    const write = native.writes.find((candidate) => candidate.row === native.row);
    if (write === undefined) return data;
    const offset = slot(write, frame.paint, native.column);
    if (offset === undefined) {
      this.reset();
      return data;
    }
    const prefix = write.text.slice(0, offset);
    const suffix = write.text.slice(offset + frame.paint.length);
    this.previous = {
      row: native.row, column: native.column, columns: frame.columns, rows: frame.rows,
      text: write.text, paint: frame.paint,
    };
    if (previous === undefined || previous.text !== prefix + previous.paint + suffix) return data;
    // Native rows finish in the default SGR/link state. Replay only controls to
    // reconstruct the cell's inherited styles and restore that same final state.
    const before = write.controls.filter((control) => control.end <= offset).map((control) => control.text).join("");
    const after = write.controls.filter((control) => control.start >= offset + frame.paint.length).map((control) => control.text).join("");
    const cell = `\x1b[${native.row};${native.column}H${before}${frame.paint}${after}`;
    return data.slice(0, write.start) + cell + data.slice(write.end);
  }
}
