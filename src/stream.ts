import { performance } from "node:perf_hooks";
import { startDeepgramStream } from "./deepgram.ts";
import { transcribe } from "./providers.ts";
import { encodeWav } from "./recorder.ts";
import { createSegmenter } from "./segmenter.ts";
import type { StartTranscriptionStream, Transcribe, TranscriptionStream } from "./types.ts";

const GROQ_REQUEST_INTERVAL_MS = 3_100;
type State = "recording" | "finishing" | "finished" | "failed" | "cancelled";

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, milliseconds);
  function abort(): void {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reject(signal.reason);
  }
  signal.addEventListener("abort", abort, { once: true });
  return promise;
}

export function createStartTranscriptionStream(
  transcribeAudio?: Transcribe,
  now: () => number = () => performance.now(),
): StartTranscriptionStream {
  let lastGroqStart = -Infinity;

  async function request<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
    let remaining = lastGroqStart + GROQ_REQUEST_INTERVAL_MS - now();
    while (remaining > 0) {
      await delay(remaining, signal);
      remaining = lastGroqStart + GROQ_REQUEST_INTERVAL_MS - now();
    }
    signal.throwIfAborted();
    lastGroqStart = now();
    return send();
  }

  return (config, signal, onText, onError): TranscriptionStream => {
    if (config.provider === "deepgram") return startDeepgramStream(config, signal, onText, onError);
    if (!Number.isFinite(config.maxSeconds) || config.maxSeconds <= 0 || config.maxSeconds > 300) {
      throw new Error("Recording maxSeconds must be greater than zero and at most 300.");
    }
    const maxPcmBytes = Math.ceil(config.maxSeconds * 16_000) * 2;
    const controller = new AbortController();
    const queue: Uint8Array[] = [];
    const { promise: result, resolve: resolveResult, reject: rejectResult } = Promise.withResolvers<void>();
    void result.catch(() => {});
    let state: State = "recording";
    let receivedBytes = 0;
    let draining = false;
    const segmenter = createSegmenter((pcm) => {
      if (state !== "recording" && state !== "finishing") return;
      queue.push(pcm);
      if (!draining) void drain();
    });

    function clear(): void {
      signal.removeEventListener("abort", onAbort);
      segmenter.cancel();
      queue.length = 0;
    }

    function fail(cause: unknown): void {
      if (state === "failed" || state === "cancelled" || state === "finished") return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      state = "failed";
      clear();
      controller.abort(error);
      rejectResult(error);
      queueMicrotask(() => {
        if (state !== "failed") return;
        try { onError(error); } catch {}
      });
    }

    function complete(): void {
      if (state !== "finishing" || draining || queue.length > 0) return;
      state = "finished";
      clear();
      resolveResult();
    }

    async function drain(): Promise<void> {
      draining = true;
      try {
        while (queue.length > 0 && (state === "recording" || state === "finishing")) {
          const audio = encodeWav(queue.shift()!);
          const text = transcribeAudio
            ? await request(controller.signal, () => transcribeAudio(audio, config, controller.signal))
            : await transcribe(audio, config, controller.signal, (input, init) =>
              request(init?.signal ?? controller.signal, () => fetch(input, init)));
          if (state !== "recording" && state !== "finishing") return;
          if (text.trim()) onText({ text, final: true });
        }
      } catch (error) {
        fail(error);
      } finally {
        draining = false;
        complete();
      }
    }

    function onAbort(): void {
      stream.cancel();
    }

    const stream: TranscriptionStream = {
      pushAudio(pcm): void {
        if (state !== "recording") return;
        if (receivedBytes + pcm.byteLength > maxPcmBytes) {
          fail(new Error(`Microphone audio exceeded the ${config.maxSeconds}-second transcription buffer limit.`));
          return;
        }
        receivedBytes += pcm.byteLength;
        try { segmenter.push(pcm); } catch (error) { fail(error); }
      },
      finish(): Promise<void> {
        if (state !== "recording") return result;
        state = "finishing";
        try { segmenter.finish(); } catch (error) { fail(error); }
        complete();
        return result;
      },
      cancel(): void {
        if (state === "cancelled" || state === "finished") return;
        state = "cancelled";
        clear();
        const error = new Error("Transcription was cancelled.");
        error.name = "AbortError";
        controller.abort(error);
        rejectResult(error);
      },
    };
    if (signal.aborted) stream.cancel();
    else signal.addEventListener("abort", onAbort, { once: true });
    return stream;
  };
}

export const startTranscriptionStream: StartTranscriptionStream = createStartTranscriptionStream();
