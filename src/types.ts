export type Provider = "groq" | "deepgram";

export interface VoiceConfig {
  provider: Provider;
  language: string;
  holdMs: number;
  releaseMs: number;
  maxSeconds: number;
  timeoutMs: number;
  groq: { model: string; apiKeyEnv: string; apiKeyFile?: string };
  deepgram: { model: string; apiKeyEnv: string; apiKeyFile?: string };
  capture: { ffmpegPath: string; device: string };
  cursor: { enabled: boolean; reducedMotion: boolean };
}

export interface Recording {
  stop(): Promise<Uint8Array>;
  cancel(): void;
}

export type StartRecording = (config: VoiceConfig, onError: (error: Error) => void, onAudio?: (pcm: Uint8Array) => void) => Recording;
export type Transcribe = (audio: Uint8Array, config: VoiceConfig, signal: AbortSignal) => Promise<string>;

export interface TranscriptionStream {
  pushAudio(pcm: Uint8Array): void;
  finish(): Promise<void>;
  cancel(): void;
}

export interface TranscriptUpdate {
  text: string;
  final: boolean;
}

export type StartTranscriptionStream = (
  config: VoiceConfig,
  signal: AbortSignal,
  onText: (update: TranscriptUpdate) => void,
  onError: (error: Error) => void,
) => TranscriptionStream;
