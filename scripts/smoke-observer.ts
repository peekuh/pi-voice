import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { CURSOR_MARKER, isKittyProtocolActive } from "@earendil-works/pi-tui";

interface ProbeEditor {
  getText(): string;
  getCursor(): { line: number; col: number };
  render(width: number): string[];
  spaceHold?: { handler?: unknown; keys: readonly unknown[] };
  readonly voiceState: "idle" | "recording" | "transcribing";
}
interface ProbeSurface {
  terminal: { write(data: string): void };
  getShowHardwareCursor(): boolean;
  requestRender(): void;
  getFocused?(): ProbeEditor | null;
}
type ProbeFactory = (surface: ProbeSurface, theme: unknown, keys: unknown) => ProbeEditor;
interface ProbeContext {
  hasUI: boolean;
  agent?: { kind: string };
  ui: {
    onTerminalInput(handler: (data: string) => void): () => void;
    getEditorComponent?(): ProbeFactory | undefined;
    setEditorComponent(factory: ProbeFactory): void;
    custom(factory: (surface: ProbeSurface, theme: unknown, keys: unknown, done: (value: unknown) => void) => { render(): string[]; invalidate(): void }): Promise<unknown>;
  };
}

export default function observe(api: { on(name: string, handler: (event: unknown, ctx: ProbeContext) => unknown): unknown }): void {
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let restoreTerminal: (() => void) | undefined;
  let status = "unknown";
  let packets = 0;
  let recordingFrames = 0;
  let editorGeneration = 0;
  const wire = { connections: 0, opens: 0, audioBytes: 0, interims: 0, finals: [] as string[], lastText: "", lastFinal: true,
    firstInterimBytes: null as number | null, closeStream: 0, closed: 0, http: 0 };
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    private observed: boolean;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.observed = new URL(url).hostname === "api.deepgram.com";
      if (!this.observed) return;
      wire.connections++;
      this.addEventListener("open", () => wire.opens++);
      this.addEventListener("close", event => { wire.closed = event.code; });
      this.addEventListener("message", event => {
        try {
          const data: unknown = JSON.parse(String(event.data));
          if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "Results"
            || !("is_final" in data) || typeof data.is_final !== "boolean" || !("channel" in data)) return;
          const channel = data.channel;
          if (typeof channel !== "object" || channel === null || !("alternatives" in channel) || !Array.isArray(channel.alternatives)) return;
          const alternative: unknown = channel.alternatives[0];
          if (typeof alternative !== "object" || alternative === null || !("transcript" in alternative) || typeof alternative.transcript !== "string") return;
          const text = alternative.transcript;
          wire.lastText = text;
          wire.lastFinal = data.is_final;
          if (data.is_final) {
            if (text.trim()) wire.finals.push(text);
          } else if (text.trim()) {
            wire.interims++;
            wire.firstInterimBytes ??= wire.audioBytes;
          }
        } catch {}
      });
    }
    override send(data: string | Blob | BufferSource): void {
      if (this.observed) {
        if (typeof data === "string") {
          try { if (JSON.parse(data).type === "CloseStream") wire.closeStream++; } catch {}
        } else wire.audioBytes += data instanceof Blob ? data.size : data.byteLength;
      }
      super.send(data);
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "api.deepgram.com" && url.pathname === "/v1/listen") wire.http++;
    return originalFetch(input, init);
  };

  function attach(editor: ProbeEditor, surface: ProbeSurface): void {
    clearInterval(timer);
    editorGeneration++;
    if (typeof editor?.getCursor !== "function") throw new Error("Voice smoke could not find the live editor");
    if (editor.voiceState === undefined) throw new Error("Voice adapter is not the active editor");
    const originalHardware = surface.getShowHardwareCursor();
    const paintStats = { renders: 0, writes: 0, caretWrites: 0, erases: 0, cellPatches: 0 };
    const terminalWrite = surface.terminal.write.bind(surface.terminal);
    surface.terminal.write = (data: string) => {
      paintStats.writes++;
      const positions = [...data.matchAll(/\x1b\[(\d+);(\d+)H/g)];
      const caret = positions.at(-1);
      if (caret) {
        paintStats.caretWrites++;
        if (/[▁▂▃▄▅▆▇█]/u.test(data) && !data.includes("\x1b[2K")) paintStats.cellPatches++;
        for (const erased of data.matchAll(/\x1b\[(\d+);1H\x1b\[2K/g)) {
          if (erased[1] === caret[1]) paintStats.erases++;
        }
      }
      if (process.env.PI_VOICE_SMOKE_WRITES) appendFileSync(process.env.PI_VOICE_SMOKE_WRITES,
        `${JSON.stringify({ at: performance.now(), data })}\n`, { mode: 0o600 });
      return terminalWrite(data);
    };
    restoreTerminal = () => { surface.terminal.write = terminalWrite; };
    const render = editor.render.bind(editor);
    let visual = { glyph: null as string | null, rgb: null as string | null, phase: "idle", hardware: originalHardware, row: "" };
    const cursorHistory: typeof visual[] = [];
    editor.render = (width: number) => {
      paintStats.renders++;
      status = editor.voiceState === "idle" ? "voice ready · hold Space" : `${editor.voiceState} · voice`;
      if (process.env.PI_VOICE_SMOKE_HOST === "omp" && editor.voiceState === "recording" && ++recordingFrames === 20) {
        const deadline = performance.now() + 350;
        while (performance.now() < deadline) {}
      }
      const lines: string[] = render(width);
      const row = lines.find(line => line.includes(CURSOR_MARKER)) ?? "";
      const tail = row.slice(row.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length);
      const match = /^(?:\x1b\[[\d;:]*m)*([▁▂▃▄▅▆▇█])/u.exec(tail);
      visual = { glyph: match?.[1] ?? null, rgb: match ? /^\x1b\[38;2;[\d;]+m/.exec(tail)?.[0] ?? null : null,
        phase: status.split(" ")[0], hardware: surface.getShowHardwareCursor(), row: row.split(CURSOR_MARKER).join("") };
      const previous = cursorHistory.at(-1);
      if (!previous || previous.phase !== visual.phase || previous.glyph !== visual.glyph) {
        cursorHistory.push({ ...visual });
        if (cursorHistory.length > 24) cursorHistory.shift();
      }
      return lines;
    };
    timer = setInterval(() => {
      try {
        const file = process.env.PI_VOICE_SMOKE_SNAPSHOT!;
        writeFileSync(`${file}.tmp`, JSON.stringify({ text: editor.getText(), cursor: editor.getCursor(), status,
          kitty: isKittyProtocolActive(), wire, visual, cursorHistory, originalHardware, paintStats, editorGeneration,
          nativeSpaceDisabled: editor.spaceHold ? editor.spaceHold.handler === undefined || editor.spaceHold.keys.length === 0 : null }));
        renameSync(`${file}.tmp`, file);
      } catch {}
    }, 25);
    surface.requestRender();
  }

  async function attachOmp(ctx: ProbeContext): Promise<void> {
    clearInterval(timer);
    restoreTerminal?.();
    restoreTerminal = undefined;
    let surface: ProbeSurface | undefined;
    await ctx.ui.custom((tui, _theme, _keys, done) => {
      surface = tui;
      setTimeout(() => done(undefined), 0);
      return { render: () => [], invalidate: () => {} };
    });
    const focused = surface?.getFocused?.();
    if (!surface || !focused) throw new Error("OMP smoke did not restore editor focus");
    attach(focused, surface);
  }

  api.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || !process.stdout.isTTY || ctx.agent?.kind === "sub") return;
    unsubscribe = ctx.ui.onTerminalInput((data: string) => {
      if ((/^ +$/.test(data) || data.startsWith("\x1b[32")) && ++packets === 65) {
        const deadline = performance.now() + 350;
        while (performance.now() < deadline) {}
      }
    });
    if (process.env.PI_VOICE_SMOKE_HOST === "omp") {
      await attachOmp(ctx);
    } else {
      timer = setInterval(() => {
        const factory = ctx.ui.getEditorComponent?.();
        if (!factory) return;
        clearInterval(timer);
        ctx.ui.setEditorComponent((surface, theme, keys) => {
          const editor = factory(surface, theme, keys);
          attach(editor, surface);
          return editor;
        });
      }, 25);
    }
  });
  if (process.env.PI_VOICE_SMOKE_HOST === "omp") {
    api.on("session_switch", async (_event, ctx) => {
      if (ctx.hasUI && ctx.agent?.kind !== "sub") await attachOmp(ctx);
    });
  }
  api.on("session_shutdown", () => {
    clearInterval(timer);
    unsubscribe?.();
    restoreTerminal?.();
    globalThis.WebSocket = NativeSocket;
    globalThis.fetch = originalFetch;
  });
}
