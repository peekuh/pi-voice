export interface VoiceCursorFrame {
  state: "recording" | "transcribing";
  level: number;
  active: boolean;
  nowMs: number;
  reducedMotion: boolean;
  color: boolean;
}

const blocks = "▁▂▃▄▅▆▇█";

export function voiceCursorPaint(frame: VoiceCursorFrame, restoreForeground = "\x1b[39m"): string {
  const transcribing = frame.state === "transcribing";
  const level = Number.isNaN(frame.level) ? 0 : Math.max(0, Math.min(1, frame.level));
  const glyph = transcribing ? "▄" : frame.reducedMotion ? "▆" : blocks[Math.round(level * 7)];
  if (!frame.color) return glyph;
  let foreground: string;
  if (transcribing) foreground = "\x1b[38;2;145;153;166m";
  else if (frame.reducedMotion) foreground = "\x1b[38;2;94;211;139m";
  else if (!frame.active) foreground = "\x1b[38;2;128;128;128m";
  else {
    const time = Number.isFinite(frame.nowMs) ? frame.nowMs : 0;
    const sector = (((time % 4_000) + 4_000) % 4_000) * 6 / 4_000;
    const ramp = 142 * (1 - Math.abs(sector % 2 - 1));
    const red = sector < 1 || sector >= 5 ? 142 : sector < 2 || sector >= 4 ? ramp : 0;
    const green = sector < 1 ? ramp : sector < 3 ? 142 : sector < 4 ? ramp : 0;
    const blue = sector < 2 ? 0 : sector < 3 ? ramp : sector < 5 ? 142 : ramp;
    foreground = `\x1b[38;2;${Math.round(red + 82)};${Math.round(green + 82)};${Math.round(blue + 82)}m`;
  }
  return foreground + glyph + restoreForeground;
}
