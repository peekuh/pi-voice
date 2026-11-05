import type { Recording, StartRecording, StartTranscriptionStream, TranscriptionStream, TranscriptUpdate, VoiceConfig } from "./types.ts";
import { AudioMeter } from "./audio-meter.ts";

export type VoiceState = "idle" | "recording" | "transcribing";

export interface DictationUI {
  focused(): boolean;
  update(update: TranscriptUpdate): void;
  clearPreview(): void;
  state(state: VoiceState): void;
  error(message: string): void;
}

interface DictationSession {
  recording?: Recording;
  stream?: TranscriptionStream;
  abort: AbortController;
  hasText: boolean;
}

export class Dictation {
  private ui: DictationUI;
  private record: StartRecording;
  private startStream: StartTranscriptionStream;
  private current: DictationSession | undefined;
  private phase: VoiceState = "idle";
  private readonly meter = new AudioMeter();

  constructor(ui: DictationUI, record: StartRecording, startStream: StartTranscriptionStream) {
    this.ui = ui;
    this.record = record;
    this.startStream = startStream;
  }

  get state(): VoiceState { return this.phase; }

  get audioLevel(): number {
    return this.phase === "recording" ? this.meter.sample() : 0;
  }

  get audioActive(): boolean {
    return this.phase === "recording" && this.meter.isActive();
  }

  start(config: VoiceConfig): void {
    if (this.current || !this.ui.focused()) return;
    this.ui.clearPreview();
    this.meter.reset();
    const session: DictationSession = { abort: new AbortController(), hasText: false };
    this.current = session;
    const onError = (error: Error): void => {
      if (this.current !== session) return;
      this.cancel();
      this.ui.error(error.message);
    };
    try {
      session.stream = this.startStream(config, session.abort.signal, update => {
        if (this.current !== session || session.abort.signal.aborted || !this.ui.focused()) return;
        if (update.final && update.text.trim()) session.hasText = true;
        this.ui.update(update);
      }, onError);
      if (this.current !== session) {
        session.stream.cancel();
        return;
      }
      session.recording = this.record(config, onError, pcm => {
        if (this.current !== session || session.abort.signal.aborted) return;
        if (this.phase === "recording") this.meter.push(pcm);
        session.stream?.pushAudio(pcm);
      });
      if (this.current !== session) {
        session.recording.cancel();
        session.stream.cancel();
        return;
      }
      this.setState("recording");
    } catch (error) {
      onError(error instanceof Error ? error : new Error("Could not start microphone recording."));
    }
  }

  async stop(): Promise<void> {
    const current = this.current;
    if (!current || this.phase !== "recording") return;
    this.setState("transcribing");
    try {
      await current.recording?.stop();
      if (this.current !== current || current.abort.signal.aborted) return;
      await current.stream?.finish();
      if (this.current === current && !current.hasText && !current.abort.signal.aborted && this.ui.focused()) {
        this.ui.error("No speech detected; the prompt was not changed.");
      }
    } catch (error) {
      if (this.current === current && !current.abort.signal.aborted) {
        this.ui.error(error instanceof Error ? error.message : "Transcription failed.");
      }
    } finally {
      if (this.current === current) this.cancel();
    }
  }

  cancel(): void {
    const current = this.current;
    this.current = undefined;
    current?.abort.abort();
    current?.recording?.cancel();
    current?.stream?.cancel();
    this.ui.clearPreview();
    this.meter.reset();
    this.setState("idle");
  }

  private setState(state: VoiceState): void {
    this.phase = state;
    this.ui.state(state);
  }
}
