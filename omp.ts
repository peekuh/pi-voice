import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_MARKER, isKeyRelease, isKittyProtocolActive, matchesKey, parseKey, visibleWidth, type TUI } from "@oh-my-pi/pi-tui";
import type { EditorTheme } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, configPath, saveProvider } from "./src/config.ts";
import { Dictation, type VoiceState } from "./src/controller.ts";
import { SpaceHold } from "./src/hold.ts";
import { startRecording } from "./src/recorder.ts";
import { startTranscriptionStream } from "./src/stream.ts";
import { TranscriptDraft } from "./src/transcript.ts";
import { voiceCursorPaint, type VoiceCursorFrame } from "./src/cursor-style.ts";
import { CURSOR_FRAME_INTERVAL_MS, CursorAnimation } from "./src/cursor-animation.ts";
import { paintOmpCursor } from "./src/omp-cursor.ts";
import type { VoiceConfig } from "./src/types.ts";

export default function voice(omp: ExtensionAPI): void {
  let config: VoiceConfig;
  let context: ExtensionContext | undefined;
  let editor: CustomEditor | undefined;
  let editorFactory: ((tui: TUI, theme: EditorTheme, keys: KeybindingsManager) => CustomEditor) | undefined;
  let hold: SpaceHold | undefined;
  let transcriptDraft: TranscriptDraft | undefined;
  let enabled = true;
  let installed = false;
  let installEpoch = 0;
  let cursorSurface: TUI | undefined;
  let cursorLease: { surface: TUI; editor: CustomEditor; hardware: boolean } | undefined;
  let cursorTimer: NodeJS.Timeout | undefined;
  let cursorFrame: VoiceCursorFrame | undefined;
  let cursorPaint: string | undefined;
  let unsubscribeInput: (() => void) | undefined;
  const cursorAnimation = new CursorAnimation();
  const cursorMetrics = { marker: CURSOR_MARKER, visibleWidth };
  const controller = new Dictation({
    focused: () => installed && enabled && !!editor?.focused,
    update: update => {
      transcriptDraft?.update(update);
      redraw();
    },
    clearPreview: () => {
      transcriptDraft?.clear();
      redraw();
    },
    state: state => {
      if (!context || !config || !installed) return;
      const route = config.provider === "deepgram" ? "deepgram realtime" : "groq phrases";
      const label = !enabled ? "voice off" : state === "idle" ? `voice ${route} · hold Space` : `${state} · ${route} · Esc cancels`;
      context.ui.setStatus("pi-voice", label);
      syncVoiceCursor();
    },
    error: message => context?.ui.notify(message, "error"),
  }, startRecording, startTranscriptionStream);

  function mainTui(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && ctx.agent.kind === "main" && ctx.hasUI && !!process.stdout.isTTY;
  }

  function redraw(): void {
    if (editor) cursorSurface?.requestComponentRender(editor);
  }

  function disableNativeHold(): void {
    if (!editor) return;
    editor.spaceHold.handler = undefined;
    editor.spaceHold.keys = [];
  }

  function cancel(): void {
    transcriptDraft?.clear();
    hold?.reset();
    controller.cancel();
    redraw();
  }

  function observeTerminal(ctx: ExtensionContext): void {
    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput(data => {
      if (/\x1b\[(?:<|M)|\x1b\[O/.test(data)) cancel();
      return undefined;
    });
  }

  function restoreVoiceCursor(): void {
    clearInterval(cursorTimer);
    cursorTimer = undefined;
    cursorFrame = undefined;
    cursorPaint = undefined;
    cursorAnimation.reset();
    if (!cursorLease) return;
    const { surface, editor: leasedEditor, hardware } = cursorLease;
    cursorLease = undefined;
    const terminalCursor = leasedEditor.getUseTerminalCursor();
    if (!surface.getShowHardwareCursor()) surface.setShowHardwareCursor(hardware);
    leasedEditor.setUseTerminalCursor(terminalCursor);
    redraw();
  }

  function sampleVoiceCursor(): void {
    const state = controller.state;
    if (!cursorSurface || !config.cursor.enabled || !editor?.focused || state === "idle") return;
    const frame = cursorAnimation.update({
      state,
      level: controller.audioLevel,
      active: controller.audioActive,
      nowMs: performance.now(),
      reducedMotion: config.cursor.reducedMotion,
      color: !process.env.NO_COLOR,
    });
    const paint = voiceCursorPaint(frame);
    cursorFrame = frame;
    if (paint === cursorPaint) return;
    cursorPaint = paint;
    redraw();
  }

  function syncVoiceCursor(): void {
    const state = controller.state;
    if (!cursorSurface || !config?.cursor.enabled || !editor?.focused || state === "idle") {
      restoreVoiceCursor();
      return;
    }
    if (!cursorLease) {
      const terminalCursor = editor.getUseTerminalCursor();
      cursorLease = { surface: cursorSurface, editor, hardware: cursorSurface.getShowHardwareCursor() };
      cursorSurface.setShowHardwareCursor(false);
      editor.setUseTerminalCursor(terminalCursor);
    }
    if (state === "recording" && !config.cursor.reducedMotion) {
      if (!cursorTimer) {
        cursorTimer = setInterval(() => {
          if (controller.state !== "recording" || !editor?.focused) syncVoiceCursor();
          else sampleVoiceCursor();
        }, CURSOR_FRAME_INTERVAL_MS);
        cursorTimer.unref();
      }
    } else {
      clearInterval(cursorTimer);
      cursorTimer = undefined;
    }
    sampleVoiceCursor();
  }

  function stop(): void {
    void controller.stop().catch(error => context?.ui.notify(String(error), "error"));
  }

  omp.on("session_start", async (_event, ctx) => {
    if (!mainTui(ctx)) return;
    const epoch = ++installEpoch;
    context = ctx;
    cancel();
    try {
      const loaded = await loadConfig();
      if (epoch !== installEpoch) return;
      config = loaded;
      if (installed) {
        disableNativeHold();
        controller.cancel();
        return;
      }
      editorFactory = (tui, theme, keys) => {
        restoreVoiceCursor();
        cursorSurface = tui;
        class VoiceEditor extends CustomEditor {
          wantsKeyRelease = true;
          private ownedSpaces = 0;
          private lastSpaceText = "";
          private lastSpaceCursor = "";

          get voiceState(): VoiceState { return controller.state; }

          constructor() {
            super(tui, theme, keys);
            let focused = this.focused;
            Object.defineProperty(this, "focused", {
              configurable: true,
              get: () => focused,
              set: (value: boolean) => {
                if (!value && focused) cancel();
                focused = value;
                if (!value) restoreVoiceCursor();
              },
            });
          }

          override render(width: number): readonly string[] {
            if (!config.cursor.enabled || !this.focused || this.voiceState === "idle" || !cursorFrame) return super.render(width);
            const terminalCursor = this.getUseTerminalCursor();
            const previousOverride = this.cursorOverride;
            const { line, col } = this.getCursor();
            const atEnd = col === (this.getLines()[line]?.length ?? 0);
            try {
              this.setUseTerminalCursor(!atEnd);
              this.cursorOverride = cursorPaint;
              const lines = super.render(width);
              return atEnd ? lines : paintOmpCursor(lines, cursorFrame, cursorMetrics);
            } finally {
              this.cursorOverride = previousOverride;
              this.setUseTerminalCursor(terminalCursor);
            }
          }

          override capturesInput(data: string): boolean {
            disableNativeHold();
            const key = parseKey(data);
            return matchesKey(data, "ctrl+shift+r") || /^ +$/.test(data) || key === "space"
              || (controller.state !== "idle" && (key === "escape" || key === "ctrl+c"));
          }

          insertOwnedSpaces(count: number): void {
            transcriptDraft?.clear();
            const cursor = JSON.stringify(this.getCursor());
            if (this.getText() !== this.lastSpaceText || cursor !== this.lastSpaceCursor) this.ownedSpaces = 0;
            this.insertText(" ".repeat(count));
            this.ownedSpaces += count;
            this.lastSpaceText = this.getText();
            this.lastSpaceCursor = JSON.stringify(this.getCursor());
            transcriptDraft?.clear();
            redraw();
          }

          removeOwnedSpaces(count: number): void {
            transcriptDraft?.clear();
            const { line, col } = this.getCursor();
            if (count > this.ownedSpaces || this.getText() !== this.lastSpaceText ||
                JSON.stringify(this.getCursor()) !== this.lastSpaceCursor ||
                this.getLines()[line]?.slice(col - count, col) !== " ".repeat(count)) return;
            this.deleteBeforeCursor(count);
            this.ownedSpaces = 0;
            transcriptDraft?.clear();
            redraw();
          }

          deleteTranscriptText(count: number): void {
            for (let index = 0; index < count; index++) super.handleInput("\x7f");
          }

          override handleInput(data: string): void {
            disableNativeHold();
            const release = isKeyRelease(data);
            const key = parseKey(data);
            const spaces = /^ +$/.test(data) ? data.length : key === "space" ? 1 : 0;
            if (spaces > 0 && !data.includes("\x1b[200~")) {
              if (release) hold?.release();
              else if (enabled) hold?.press(spaces);
              else this.insertOwnedSpaces(spaces);
              return;
            }
            if (release) return;
            this.ownedSpaces = 0;
            if (matchesKey(data, "ctrl+shift+r")) {
              if (!enabled) return;
              hold?.reset();
              if (controller.state === "recording") stop();
              else if (controller.state === "transcribing") cancel();
              else {
                transcriptDraft?.clear();
                controller.start(config);
              }
              return;
            }
            if (key === "escape" || key === "ctrl+c") {
              const busy = controller.state !== "idle";
              cancel();
              if (busy) return;
            } else {
              transcriptDraft?.clear();
              hold?.release();
              if (controller.state === "recording") stop();
              if (key === "enter" || key === "ctrl+enter") cancel();
            }
            try {
              super.handleInput(data);
            } finally {
              transcriptDraft?.clear();
            }
          }
        }
        const voiceEditor = new VoiceEditor();
        editor = voiceEditor;
        transcriptDraft = new TranscriptDraft({
          getText: voiceEditor.getText.bind(voiceEditor),
          getCursor: voiceEditor.getCursor.bind(voiceEditor),
          getLines: voiceEditor.getLines.bind(voiceEditor),
          insertText: voiceEditor.insertText.bind(voiceEditor),
          deleteBackward: voiceEditor.deleteTranscriptText.bind(voiceEditor),
          nativePreview: {
            set: voiceEditor.setVolatileText.bind(voiceEditor),
            commit: voiceEditor.commitVolatileText.bind(voiceEditor),
            clear: voiceEditor.clearVolatileText.bind(voiceEditor),
          },
        });
        hold = new SpaceHold({
          holdMs: config.holdMs,
          releaseMs: config.releaseMs,
          canRecord: () => installed && enabled && !!editor?.focused && controller.state === "idle",
          tap: count => voiceEditor.insertOwnedSpaces(count),
          removeTaps: count => voiceEditor.removeOwnedSpaces(count),
          start: () => {
            transcriptDraft?.clear();
            controller.start(config);
          },
          stop,
        });
        return voiceEditor;
      };
      ctx.ui.setEditorComponent(editorFactory);
      // OMP wires its own handler after the factory returns; disable only this editor's gesture.
      disableNativeHold();
      installed = true;
      observeTerminal(ctx);
      controller.cancel();
    } catch (error) {
      ctx.ui.notify(`pi-voice: ${error instanceof Error ? error.message : "Could not load configuration."}`, "error");
    }
  });

  omp.on("input", (_event, ctx) => {
    if (mainTui(ctx)) cancel();
  });
  omp.on("session_before_switch", (_event, ctx) => {
    if (mainTui(ctx)) cancel();
  });
  omp.on("session_switch", (_event, ctx) => {
    if (!mainTui(ctx)) return;
    context = ctx;
    cancel();
    if (installed && editorFactory) ctx.ui.setEditorComponent(editorFactory);
    disableNativeHold();
    observeTerminal(ctx);
  });
  omp.on("session_shutdown", (_event, ctx) => {
    if (!mainTui(ctx)) return;
    ++installEpoch;
    cancel();
    restoreVoiceCursor();
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    if (installed) ctx.ui.setEditorComponent(undefined);
    ctx.ui.setStatus("pi-voice", undefined);
    editor = undefined;
    editorFactory = undefined;
    transcriptDraft = undefined;
    hold = undefined;
    installed = false;
    cursorSurface = undefined;
    context = undefined;
  });

  omp.registerCommand("voice", {
    description: "Cloud dictation: status, provider groq|deepgram, on, off, cancel, doctor",
    handler: async (args, ctx) => {
      if (!mainTui(ctx) || !installed) {
        if (mainTui(ctx)) ctx.ui.notify("Voice requires an interactive OMP main-agent prompt.", "error");
        return;
      }
      const command = args.trim().toLowerCase();
      if (/^provider (groq|deepgram)$/.test(command)) {
        cancel();
        const provider = command.endsWith("groq") ? "groq" : "deepgram";
        await saveProvider(provider);
        config = await loadConfig();
        controller.cancel();
        ctx.ui.notify(`Voice provider: ${config.provider}.`, "info");
      } else if (command === "off" || command === "on") {
        enabled = command === "on";
        cancel();
      } else if (command === "cancel") cancel();
      else if (command === "doctor") {
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
      } else ctx.ui.notify("Usage: /voice [status|provider groq|provider deepgram|on|off|cancel|doctor]", "warning");
    },
  });
}
