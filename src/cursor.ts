import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";

import { voiceCursorPaint, type VoiceCursorFrame } from "./cursor-style.ts";

const sentinel = "voice-cursor-delimiter-probe";
const fakeCursor = renderFakeCursor(sentinel);
const sentinelIndex = fakeCursor.indexOf(sentinel);
const slotStart = fakeCursor.slice(0, sentinelIndex);
const slotEnd = fakeCursor.slice(sentinelIndex + sentinel.length);

function foregroundAt(line: string, end: number): string {
  const sgr = /\x1b\[([\d;:]*)m/g;
  let foreground = "\x1b[39m";
  let match: RegExpExecArray | null;
  while ((match = sgr.exec(line)) !== null && match.index < end) {
    const codes = match[1].split(";");
    for (let index = 0; index < codes.length; index++) {
      const code = Number(codes[index].split(":", 1)[0]);
      if (code === 0 || code === 39) foreground = "\x1b[39m";
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        foreground = `\x1b[${code}m`;
      } else if (code === 38 || code === 48 || code === 58) {
        const count = codes[index].includes(":") ? 1 : codes[index + 1] === "2" ? 5 : 3;
        if (code === 38) foreground = `\x1b[${codes.slice(index, index + count).join(";")}m`;
        index += count - 1;
      }
    }
  }
  return foreground;
}

export function renderVoiceCursor(lines: readonly string[], frame: VoiceCursorFrame): string[] {
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    let marker = line.indexOf(CURSOR_MARKER);
    while (marker !== -1) {
      const start = marker + CURSOR_MARKER.length;
      if (slotStart.length > 0 && slotEnd.length > 0 && line.startsWith(slotStart, start)) {
        const contentStart = start + slotStart.length;
        const end = line.indexOf(slotEnd, contentStart);
        if (end !== -1) {
          const width = visibleWidth(line.slice(contentStart, end));
          if (width > 0) {
            const cursor = voiceCursorPaint(frame, foregroundAt(line, start));
            const replacement = line.slice(0, start) + cursor + " ".repeat(width - 1)
              + line.slice(end + slotEnd.length);
            const result = lines.slice();
            result[row] = replacement;
            return result;
          }
        }
      }
      marker = line.indexOf(CURSOR_MARKER, start);
    }
  }
  return lines as string[];
}
