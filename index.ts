import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, isKeyRelease, isKittyProtocolActive, matchesKey, parseKey, renderFakeCursor, type TUI } from "@earendil-works/pi-tui";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, configPath, saveProvider } from "./src/config.ts";
import { Dictation } from "./src/controller.ts";
import { SpaceHold } from "./src/hold.ts";
import { startRecording } from "./src/recorder.ts";
import { startTranscriptionStream } from "./src/stream.ts";
import { TranscriptDraft } from "./src/transcript.ts";
import { renderVoiceCursor, type VoiceCursorFrame } from "./src/cursor.ts";
import { CURSOR_FRAME_INTERVAL_MS, CursorAnimation } from "./src/cursor-animation.ts";
import { CursorCellOutput } from "./src/cursor-output.ts";
import type { VoiceConfig } from "./src/types.ts";

const cursorProbe = [CURSOR_MARKER + renderFakeCursor(" ")];

export default function voice(pi: ExtensionAPI): void {
  let config: VoiceConfig;
  let context: ExtensionContext | undefined;
  let editor: CustomEditor | undefined;
  let hold: SpaceHold | undefined;
  let redraw: (() => void) | undefined;
  let transcriptDraft: TranscriptDraft | undefined;
  let enabled = true;
  let installed = false;
  let cursorSurface: TUI | undefined;
  let cursorLease: { surface: TUI; hardware: boolean } | undefined;
  let cursorTimer: NodeJS.Timeout | undefined;
  let cursorFrame: VoiceCursorFrame | undefined;
  let cursorPaint: string | undefined;
  const cursorAnimation = new CursorAnimation();
  let detachCursorOutput: (() => void) | undefined;
  const controller = new Dictation({
    focused: () => enabled && !!editor?.focused,
    update: update => {
      transcriptDraft?.update(update);
      redraw?.();
    },
    clearPreview: () => {
      transcriptDraft?.clear();
      redraw?.();
    },
    state: state => {
      if (!context?.hasUI || !config) return;
      const route = config.provider === "deepgram" ? "deepgram realtime" : "groq phrases";
      const label = !enabled ? "voice off" : state === "idle" ? `voice ${route} · hold Space` : `${state} · ${route} · Esc cancels`;
      context.ui.setStatus("pi-voice", label);
      syncVoiceCursor();
    },
    error: message => context?.ui.notify(message, "error"),
  }, startRecording, startTranscriptionStream);

  function restoreVoiceCursor(): void {
    clearInterval(cursorTimer);
    cursorTimer = undefined;
    cursorFrame = undefined;
    cursorPaint = undefined;
    cursorAnimation.reset();
    detachCursorOutput?.();
    detachCursorOutput = undefined;
    if (!cursorLease) return;
    const { surface, hardware } = cursorLease;
    cursorLease = undefined;
    surface.setShowHardwareCursor(hardware);
    surface.requestRender();
  }

  function sampleVoiceCursor(): void {
    const state = controller.state;
    if (!cursorSurface || !config.cursor.enabled || !editor?.focused || state === "idle") return;
    const frame = cursorAnimation.update({
      state,
      level: controller.audioLevel,
      nowMs: performance.now(),
      reducedMotion: config.cursor.reducedMotion,
      color: !process.env.NO_COLOR,
    });
    const paint = renderVoiceCursor(cursorProbe, frame)[0];
    cursorFrame = frame;
    if (paint === cursorPaint) return;
    cursorPaint = paint;
    cursorSurface.requestRender();
  }

  function syncVoiceCursor(): void {
    const state = controller.state;
    if (!cursorSurface || !config?.cursor.enabled || !editor?.focused || state === "idle") {
      restoreVoiceCursor();
      return;
    }
    if (!cursorLease) {
      cursorLease = { surface: cursorSurface, hardware: cursorSurface.getShowHardwareCursor() };
      cursorSurface.setShowHardwareCursor(false);
      if (cursorSurface.mode === "fullscreen") {
        const terminal = cursorSurface.terminal;
        const previousWrite = terminal.write;
        const output = new CursorCellOutput();
        let active = true;
        const write = (data: string): void => {
          const eligible = active && !!editor?.focused && !!cursorPaint && controller.state !== "idle";
          previousWrite.call(terminal, output.rewrite(data, eligible ? {
            paint: cursorPaint!.slice(CURSOR_MARKER.length),
            columns: terminal.columns,
            rows: terminal.rows,
          } : undefined));
        };
        terminal.write = write;
        detachCursorOutput = () => {
          active = false;
          output.reset();
          if (terminal.write === write) terminal.write = previousWrite;
        };
      }
    }
    if (state === "recording" && !config.cursor.reducedMotion) {
      if (!cursorTimer) {
        cursorTimer = setInterval(() => {
          if (controller.state !== "recording" || !editor?.focused) {
            syncVoiceCursor();
            return;
          }
          sampleVoiceCursor();
        }, CURSOR_FRAME_INTERVAL_MS);
        cursorTimer.unref();
      }
    } else {
      clearInterval(cursorTimer);
      cursorTimer = undefined;
    }
    sampleVoiceCursor();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || !process.stdout.isTTY) return;
    context = ctx;
    try {
      config = await loadConfig();
      if (ctx.ui.getEditorComponent()) {
        ctx.ui.notify("pi-voice needs the prompt editor. Disable another custom-editor extension before loading it.", "error");
        return;
      }
      ctx.ui.setEditorComponent((tui, theme, keys) => {
        restoreVoiceCursor();
        cursorSurface = tui;
        redraw = tui.requestRender.bind(tui);
        hold?.reset();
        controller.cancel();
        class VoiceEditor extends CustomEditor {
          wantsKeyRelease = true;
          private ownedSpaces = 0;
          private lastSpaceText = "";
          private lastSpaceCursor = "";

          override render(width: number): string[] {
            const lines = super.render(width);
            const state = controller.state;
            if (!config.cursor.enabled || !this.focused || state === "idle" || !cursorFrame) return lines;
            return renderVoiceCursor(lines, cursorFrame);
          }

          insertOwnedSpaces(count: number): void {
            transcriptDraft?.clear();
            const cursor = JSON.stringify(this.getCursor());
            if (this.getText() !== this.lastSpaceText || cursor !== this.lastSpaceCursor) this.ownedSpaces = 0;
            this.insertTextAtCursor(" ".repeat(count));
            this.ownedSpaces += count;
            this.lastSpaceText = this.getText();
            this.lastSpaceCursor = JSON.stringify(this.getCursor());
            transcriptDraft?.clear();
            tui.requestRender();
          }

          removeOwnedSpaces(count: number): void {
            const { line, col } = this.getCursor();
            if (count > this.ownedSpaces || this.getText() !== this.lastSpaceText ||
                JSON.stringify(this.getCursor()) !== this.lastSpaceCursor ||
                this.getLines()[line].slice(col - count, col) !== " ".repeat(count)) return;
            for (let i = 0; i < count; i++) super.handleInput("\x7f");
            this.ownedSpaces = 0;
            transcriptDraft?.clear();
            tui.requestRender();
          }

          deleteTranscriptText(count: number): void {
            for (let i = 0; i < count; i++) super.handleInput("\x7f");
          }
          constructor() {
            super(tui, theme, keys);
            let focused = this.focused;
            Object.defineProperty(this, "focused", {
              configurable: true,
              get: () => focused,
              set: (value: boolean) => {
                focused = value;
                if (!value) {
                  hold?.reset();
                  controller.cancel();
                }
              },
            });
          }
          override handleInput(data: string): void {
            const release = isKeyRelease(data);
            const key = parseKey(data);
            const spaces = /^ +$/.test(data) ? data.length : key === "space" ? 1 : 0;
            if (spaces > 0 && enabled && !data.includes("\x1b[200~")) {
              if (release) hold?.release();
              else hold?.press(spaces);
              return;
            }
            if (release) return;
            this.ownedSpaces = 0;
            if (matchesKey(data, "ctrl+shift+r") && enabled) {
              hold?.reset();
              if (controller.state === "recording") {
                void controller.stop().catch(error => ctx.ui.notify(String(error), "error"));
              } else if (controller.state === "transcribing") controller.cancel();
              else controller.start(config);
              return;
            }
            if (key === "escape" || key === "ctrl+c") {
              const busy = controller.state !== "idle";
              hold?.reset();
              controller.cancel();
              if (busy) return;
            } else {
              transcriptDraft?.clear();
              hold?.release();
              if (controller.state === "recording") {
                void controller.stop().catch(error => ctx.ui.notify(String(error), "error"));
              }
              if (key === "enter" || key === "ctrl+enter") controller.cancel();
            }
            super.handleInput(data);
            transcriptDraft?.clear();
          }
        }
        const voiceEditor = new VoiceEditor();
        editor = voiceEditor;
        transcriptDraft = new TranscriptDraft({
          getText: voiceEditor.getText.bind(voiceEditor),
          getCursor: voiceEditor.getCursor.bind(voiceEditor),
          getLines: voiceEditor.getLines.bind(voiceEditor),
          insertText: voiceEditor.insertTextAtCursor.bind(voiceEditor),
          deleteBackward: voiceEditor.deleteTranscriptText.bind(voiceEditor),
        });
        hold = new SpaceHold({
          holdMs: config.holdMs,
          releaseMs: config.releaseMs,
          canRecord: () => enabled && !!editor?.focused && controller.state === "idle",
          tap: count => voiceEditor.insertOwnedSpaces(count),
          removeTaps: count => voiceEditor.removeOwnedSpaces(count),
          start: () => controller.start(config),
          stop: () => { void controller.stop().catch(error => ctx.ui.notify(String(error), "error")); },
        });
        return editor;
      });
      installed = true;
      controller.cancel();
    } catch (error) {
      ctx.ui.notify(`pi-voice: ${error instanceof Error ? error.message : "Could not load configuration."}`, "error");
    }
  });

  pi.on("input", () => {
    hold?.reset();
    controller.cancel();
  });

  pi.on("session_shutdown", () => {
    hold?.reset();
    controller.cancel();
    if (installed) context?.ui.setEditorComponent(undefined);
    context?.ui.setStatus("pi-voice", undefined);
    editor = undefined;
    redraw = undefined;
    transcriptDraft = undefined;
    installed = false;
    restoreVoiceCursor();
    cursorSurface = undefined;
  });

  pi.registerCommand("voice", {
    description: "Cloud dictation: status, provider groq|deepgram, on, off, cancel, doctor",
    handler: async (args, ctx) => {
      if (!installed) { ctx.ui.notify("Voice requires an interactive Pi session with no other custom editor.", "error"); return; }
      const command = args.trim().toLowerCase();
      if (/^provider (groq|deepgram)$/.test(command)) {
        hold?.reset();
        controller.cancel();
        const provider = command.endsWith("groq") ? "groq" : "deepgram";
        await saveProvider(provider);
        config = await loadConfig();
        controller.cancel();
        ctx.ui.notify(`Voice provider: ${config.provider}.`, "info");
      } else if (command === "off" || command === "on") {
        enabled = command === "on";
        hold?.reset();
        controller.cancel();
      } else if (command === "cancel") {
        hold?.reset();
        controller.cancel();
      } else if (command === "doctor") {
        const secret = config[config.provider];
        let credential = process.env[secret.apiKeyEnv]?.trim() ? "environment key present" : "no environment key";
        if (secret.apiKeyFile) {
          const file = secret.apiKeyFile.startsWith("~/") ? join(homedir(), secret.apiKeyFile.slice(2)) : secret.apiKeyFile;
          credential += await access(file, constants.R_OK).then(() => "; key file readable", () => "; key file unreadable");
        }
        const transport = config.provider === "deepgram" ? "realtime WebSocket with interim results" : "phrase HTTP uploads";
        ctx.ui.notify(`${config.provider}/${secret.model}; ${transport}; ${credential}; repeat-cadence hold detection (${isKittyProtocolActive() ? "Kitty negotiation active" : "legacy input"}); config ${configPath()}; recorder ${config.capture.ffmpegPath} (${config.capture.device}).`, "info");
      } else if (!command || command === "status") {
        ctx.ui.notify(`Voice ${enabled ? "on" : "off"}: ${config.provider}/${config[config.provider].model} (${config.provider === "deepgram" ? "realtime" : "phrase batch"}); ${controller.state}. Hold Space; release to finalize. Esc cancels.`, "info");
      } else {
        ctx.ui.notify("Usage: /voice [status|provider groq|provider deepgram|on|off|cancel|doctor]", "warning");
      }
    },
  });
}
