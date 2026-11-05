export interface VoiceCursorFrame {
  state: "recording" | "transcribing";
  level: number;
  nowMs: number;
  reducedMotion: boolean;
  color: boolean;
}

const blocks = "▁▂▃▄▅▆▇█";
const palette = [
  [94, 211, 139],
  [72, 199, 210],
  [106, 166, 255],
  [191, 139, 250],
  [244, 135, 172],
  [245, 183, 93],
] as const;

export function voiceCursorPaint(frame: VoiceCursorFrame, restoreForeground = "\x1b[39m"): string {
  const transcribing = frame.state === "transcribing";
  const level = Number.isNaN(frame.level) ? 0 : Math.max(0, Math.min(1, frame.level));
  const glyph = transcribing ? "▄" : frame.reducedMotion ? "▆" : blocks[Math.round(level * 7)];
  if (!frame.color) return glyph;
  let foreground: string;
  if (transcribing) foreground = "\x1b[38;2;145;153;166m";
  else if (frame.reducedMotion) foreground = "\x1b[38;2;94;211;139m";
  else {
    const time = Number.isFinite(frame.nowMs) ? frame.nowMs : 0;
    const position = (((time % 8_000) + 8_000) % 8_000) * palette.length / 8_000;
    const index = Math.floor(position);
    const fraction = position - index;
    const from = palette[index];
    const to = palette[(index + 1) % palette.length];
    const red = Math.round(from[0] + (to[0] - from[0]) * fraction);
    const green = Math.round(from[1] + (to[1] - from[1]) * fraction);
    const blue = Math.round(from[2] + (to[2] - from[2]) * fraction);
    foreground = `\x1b[38;2;${red};${green};${blue}m`;
  }
  return foreground + glyph + restoreForeground;
}
