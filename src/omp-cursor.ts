import { voiceCursorPaint, type VoiceCursorFrame } from "./cursor-style.ts";

export interface OmpCursorMetrics {
  marker: string;
  visibleWidth(text: string): number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const control = /\x1b(?:\[[\d;:]*m|\][^\x07\x1b]*(?:\x07|\x1b\\))/y;

function foregroundAt(text: string): string {
  const sgr = /\x1b\[([\d;:]*)m/g;
  let foreground = "\x1b[39m";
  let match: RegExpExecArray | null;
  while ((match = sgr.exec(text)) !== null) {
    const codes = match[1].split(";");
    for (let index = 0; index < codes.length; index++) {
      const code = Number(codes[index].split(":", 1)[0]);
      if (code === 0 || code === 39) foreground = "\x1b[39m";
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) foreground = `\x1b[${code}m`;
      else if (code === 38 || code === 48 || code === 58) {
        const count = codes[index].includes(":") ? 1 : codes[index + 1] === "2" ? 5 : 3;
        if (code === 38) foreground = `\x1b[${codes.slice(index, index + count).join(";")}m`;
        index += count - 1;
      }
    }
  }
  return foreground;
}

/** Paints the raw insertion-point grapheme emitted by native terminal-cursor mode. */
export function paintOmpCursor(
  lines: readonly string[], frame: VoiceCursorFrame, metrics: OmpCursorMetrics,
): readonly string[] {
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    const marker = line.indexOf(metrics.marker);
    if (marker === -1) continue;
    let start = marker + metrics.marker.length;
    while (line[start] === "\x1b") {
      control.lastIndex = start;
      const match = control.exec(line);
      if (!match) return lines;
      start += match[0].length;
    }
    if (start >= line.length || line.charCodeAt(start) < 32) return lines;
    const nextControl = line.indexOf("\x1b", start);
    const text = line.slice(start, nextControl === -1 ? line.length : nextControl);
    const grapheme = segmenter.segment(text)[Symbol.iterator]().next().value?.segment;
    if (!grapheme) return lines;
    const width = metrics.visibleWidth(grapheme);
    if (width < 1 || width > 2) return lines;
    const before = line.slice(0, start);
    const result = lines.slice();
    result[row] = before + voiceCursorPaint(frame, foregroundAt(before)) + " ".repeat(width - 1)
      + line.slice(start + grapheme.length);
    return result;
  }
  return lines;
}
