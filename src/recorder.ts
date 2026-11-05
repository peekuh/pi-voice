import { Buffer } from "node:buffer";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { Recording, StartRecording, VoiceConfig } from "./types.ts";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const STOP_GRACE_MS = 1_500;
const MAX_STDERR_BYTES = 4_096;

type State = "recording" | "stopping" | "stopped" | "failed" | "cancelled";
type CaptureProcess = ChildProcessByStdio<null, Readable, Readable>;

function allocateWav(pcmBytes: number): Uint8Array {
  if (pcmBytes === 0) throw new Error("No microphone audio was recorded.");
  if (pcmBytes % BYTES_PER_SAMPLE !== 0) {
    throw new Error("Recorded PCM ends with an incomplete 16-bit sample.");
  }
  if (pcmBytes > 0xffff_ffff - 36) throw new Error("Recorded audio is too large for a PCM WAV file.");

  const wav = Buffer.allocUnsafe(WAV_HEADER_BYTES + pcmBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  wav.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcmBytes, 40);
  return wav;
}

export function encodeWav(pcm: Uint8Array): Uint8Array {
  const wav = allocateWav(pcm.byteLength);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}

function captureArguments(config: VoiceConfig, platform: NodeJS.Platform): string[] {
  const device = config.capture.device || "default";
  let input: string[];
  if (platform === "linux") {
    input = ["-f", "pulse", "-sample_rate", String(SAMPLE_RATE), "-channels", "1", "-fragment_size", "512", "-i", device];
  } else if (platform === "darwin") {
    input = ["-f", "avfoundation", "-i", device === "default" ? ":0" : device];
  } else if (platform === "win32") {
    if (device === "default") {
      throw new Error("Windows capture requires an explicit DirectShow audio device name in capture.device.");
    }
    input = ["-f", "dshow", "-i", `audio=${device}`];
  } else {
    throw new Error(`Microphone capture is not supported on ${platform}.`);
  }
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    ...input,
    "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-c:a", "pcm_s16le", "-f", "s16le",
    ...(platform === "linux" ? ["-flush_packets", "1"] : []),
    "pipe:1",
  ];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createStartRecording(
  spawnProcess: typeof spawn,
  platform: NodeJS.Platform = process.platform,
): StartRecording {
  return (config, onError, onAudio): Recording => {
    if (!Number.isFinite(config.maxSeconds) || config.maxSeconds <= 0 || config.maxSeconds > 300) {
      throw new Error("Recording maxSeconds must be greater than zero and at most 300.");
    }
    const args = captureArguments(config, platform);
    const maxPcmBytes = Math.ceil(config.maxSeconds * SAMPLE_RATE) * BYTES_PER_SAMPLE;
    const chunks: Uint8Array[] = [];
    let pcmBytes = 0;
    let stderr = "";
    let child: CaptureProcess | undefined;
    let state: State = "recording";
    let exited = false;
    let durationTimer: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    const { promise: result, resolve: resolveResult, reject: rejectResult } = Promise.withResolvers<Uint8Array>();
    void result.catch(() => {});

    function clearTimers(): void {
      clearTimeout(durationTimer);
      clearTimeout(stopTimer);
      durationTimer = undefined;
      stopTimer = undefined;
    }

    function discardAndKill(): void {
      chunks.length = 0;
      pcmBytes = 0;
      if (!child) return;
      if (!exited) {
        try { child.kill("SIGKILL"); } catch {}
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }

    function fail(error: Error): void {
      if (state === "failed" || state === "cancelled" || state === "stopped") return;
      state = "failed";
      clearTimers();
      discardAndKill();
      rejectResult(error);
      queueMicrotask(() => {
        if (state === "failed") onError(error);
      });
    }

    function exitError(code: number | null, signal: NodeJS.Signals | null): Error {
      const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const detail = stderr.trim();
      return new Error(`ffmpeg microphone capture exited with ${status}${detail ? `: ${detail}` : "."}`);
    }

    const recording: Recording = {
      stop(): Promise<Uint8Array> {
        if (state !== "recording") return result;
        state = "stopping";
        clearTimeout(durationTimer);
        durationTimer = undefined;
        try {
          child!.kill("SIGINT");
        } catch (error) {
          fail(new Error(`Could not stop ffmpeg: ${asError(error).message}`));
        }
        if (state === "stopping") {
          stopTimer = setTimeout(() => {
            fail(new Error("ffmpeg did not stop within the recording shutdown deadline."));
          }, STOP_GRACE_MS);
          stopTimer.unref();
        }
        return result;
      },
      cancel(): void {
        if (state === "cancelled" || state === "stopped") return;
        state = "cancelled";
        clearTimers();
        discardAndKill();
        const error = new Error("Microphone recording was cancelled.");
        error.name = "AbortError";
        rejectResult(error);
      },
    };

    try {
      child = spawnProcess(config.capture.ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (state !== "recording" && state !== "stopping") return;
        if (pcmBytes + chunk.byteLength >= maxPcmBytes) {
          fail(new Error(`Microphone audio reached the ${config.maxSeconds}-second recording buffer limit.`));
          return;
        }
        if (chunk.byteLength === 0) return;
        chunks.push(chunk);
        pcmBytes += chunk.byteLength;
        if (onAudio) {
          try { onAudio(chunk); } catch (error) { fail(asError(error)); }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (state !== "recording" && state !== "stopping") return;
        stderr = (stderr + chunk.subarray(-MAX_STDERR_BYTES).toString("utf8")).slice(-MAX_STDERR_BYTES);
      });
      child.stdout.on("error", (error: Error) => fail(error));
      child.stderr.on("error", (error: Error) => fail(error));
      child.on("error", (error: Error) => fail(error));
      child.once("exit", (code, signal) => {
        exited = true;
        if (state === "recording") fail(exitError(code, signal));
      });
      child.once("close", (code, signal) => {
        exited = true;
        clearTimers();
        if (state === "failed" || state === "cancelled" || state === "stopped") return;
        if (state !== "stopping" || (code !== 0 && code !== 255 && signal !== "SIGINT")) {
          fail(exitError(code, signal));
          return;
        }
        try {
          const wav = allocateWav(pcmBytes);
          let offset = WAV_HEADER_BYTES;
          for (const chunk of chunks) {
            wav.set(chunk, offset);
            offset += chunk.byteLength;
          }
          chunks.length = 0;
          pcmBytes = 0;
          state = "stopped";
          resolveResult(wav);
        } catch (error) {
          fail(asError(error));
        }
      });
      durationTimer = setTimeout(() => {
        fail(new Error(`Microphone recording reached the ${config.maxSeconds}-second duration limit.`));
      }, config.maxSeconds * 1_000);
      durationTimer.unref();
    } catch (error) {
      fail(asError(error));
    }
    return recording;
  };
}

export const startRecording: StartRecording = createStartRecording(spawn);
