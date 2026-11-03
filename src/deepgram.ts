import { resolveApiKey } from "./providers.ts";
import type { StartTranscriptionStream, TranscriptionStream } from "./types.ts";

const MAX_PENDING_BYTES = 16_000 * 2 * 5;
const MAX_SOCKET_BUFFER_BYTES = 16_000 * 2 * 2;
const AUDIO_FRAME_BYTES = 16_000 * 2 / 10;
const DRAIN_INTERVAL_MS = 20;
const KEEP_ALIVE_MS = 4_000;
type State = "recording" | "finishing" | "finished" | "failed" | "cancelled";

export interface DeepgramSocket extends EventTarget {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number): void;
}

export type DeepgramSocketFactory = (url: URL, protocols: string[]) => DeepgramSocket;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutError(phase: string): Error {
  const error = new Error(`Deepgram realtime ${phase} timed out`);
  error.name = "TimeoutError";
  return error;
}

export function createStartDeepgramStream(
  createSocket: DeepgramSocketFactory = (url, protocols) => new WebSocket(url, protocols),
): StartTranscriptionStream {
  return (config, signal, onText, onError): TranscriptionStream => {
    if (!Number.isFinite(config.maxSeconds) || config.maxSeconds <= 0 || config.maxSeconds > 300) {
      throw new Error("Recording maxSeconds must be greater than zero and at most 300.");
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("Deepgram realtime timeoutMs must be greater than zero.");
    }
    const maxPcmBytes = Math.ceil(config.maxSeconds * 16_000) * 2;
    const { promise: result, resolve: resolveResult, reject: rejectResult } = Promise.withResolvers<void>();
    void result.catch(() => {});
    const queue: Uint8Array<ArrayBuffer>[] = [];
    const finalRanges = new Set<string>();
    let state: State = "recording";
    let socket: DeepgramSocket | undefined;
    let opened = false;
    let closeSent = false;
    let metadataReceived = false;
    let receivedBytes = 0;
    let queuedBytes = 0;
    let pendingByte: number | undefined;
    let openingTimer: NodeJS.Timeout | undefined;
    let finishTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let keepAliveTimer: NodeJS.Timeout | undefined;

    function active(): boolean {
      return state === "recording" || state === "finishing";
    }

    function clear(closeSocket: boolean): void {
      clearTimeout(openingTimer);
      clearTimeout(finishTimer);
      clearTimeout(drainTimer);
      clearTimeout(keepAliveTimer);
      signal.removeEventListener("abort", onAbort);
      queue.length = 0;
      queuedBytes = 0;
      pendingByte = undefined;
      finalRanges.clear();
      if (!socket) return;
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onSocketError);
      socket.removeEventListener("close", onClose);
      if (closeSocket && socket.readyState < 2) {
        try { socket.close(); } catch {}
      }
    }

    function fail(error: Error): void {
      if (!active()) return;
      state = "failed";
      clear(true);
      rejectResult(error);
      queueMicrotask(() => {
        if (state !== "failed") return;
        try { onError(error); } catch {}
      });
    }

    function connectionError(): void {
      fail(new Error("Deepgram realtime connection failed; check API key, account permissions and network connectivity"));
    }

    function scheduleKeepAlive(): void {
      clearTimeout(keepAliveTimer);
      if (!active() || closeSent) return;
      keepAliveTimer = setTimeout(() => {
        if (!active() || closeSent || !socket || socket.readyState !== 1) return;
        if (socket.bufferedAmount === 0 && queuedBytes === 0) {
          try { socket.send('{"type":"KeepAlive"}'); } catch { connectionError(); return; }
        }
        scheduleKeepAlive();
      }, KEEP_ALIVE_MS);
    }

    function scheduleDrain(): void {
      if (drainTimer !== undefined || !active() || closeSent) return;
      drainTimer = setTimeout(() => {
        drainTimer = undefined;
        drain();
      }, DRAIN_INTERVAL_MS);
    }

    function drain(): void {
      if (!active() || !opened || !socket || socket.readyState !== 1 || closeSent) return;
      if (socket.bufferedAmount + queuedBytes + (pendingByte === undefined ? 0 : 1) > MAX_PENDING_BYTES) {
        fail(new Error("Deepgram realtime audio backpressure exceeded the 5-second pending buffer limit"));
        return;
      }
      while (queue.length > 0) {
        const audio = queue[0]!;
        if (socket.bufferedAmount + audio.byteLength > MAX_SOCKET_BUFFER_BYTES) break;
        try { socket.send(audio); } catch { connectionError(); return; }
        queue.shift();
        queuedBytes -= audio.byteLength;
        scheduleKeepAlive();
      }
      if (queue.length > 0 || (state === "finishing" && socket.bufferedAmount > 0)) {
        scheduleDrain();
        return;
      }
      if (state === "finishing") {
        closeSent = true;
        clearTimeout(keepAliveTimer);
        try { socket.send('{"type":"CloseStream"}'); } catch { connectionError(); }
      }
    }

    function sendAudio(audio: Uint8Array): void {
      if (!active()) return;
      const bytes = audio.buffer instanceof ArrayBuffer ? audio as Uint8Array<ArrayBuffer> : audio.slice();
      const buffered = socket?.bufferedAmount ?? 0;
      if (buffered + queuedBytes + audio.byteLength > MAX_PENDING_BYTES) {
        fail(new Error("Deepgram realtime audio backpressure exceeded the 5-second pending buffer limit"));
        return;
      }
      if (opened && socket?.readyState === 1 && queue.length === 0 && buffered + audio.byteLength <= MAX_SOCKET_BUFFER_BYTES) {
        try { socket.send(bytes); } catch { connectionError(); return; }
        scheduleKeepAlive();
      } else {
        queue.push(audio.slice());
        queuedBytes += audio.byteLength;
        drain();
      }
    }

    function onOpen(): void {
      if (!active()) return;
      opened = true;
      clearTimeout(openingTimer);
      scheduleKeepAlive();
      drain();
    }

    function onMessage(event: Event): void {
      if (!active()) return;
      let payload: unknown;
      try {
        const data: unknown = (event as MessageEvent).data;
        if (typeof data !== "string") throw new Error();
        payload = JSON.parse(data);
      } catch {
        fail(new Error("Deepgram returned an invalid JSON realtime response"));
        return;
      }
      if (!isObject(payload) || typeof payload.type !== "string") {
        fail(new Error("Deepgram returned a malformed realtime response"));
        return;
      }
      if (payload.type === "Error") {
        fail(new Error("Deepgram realtime transcription failed; check API key, account permissions and audio settings"));
        return;
      }
      if (payload.type === "Metadata") {
        if (!closeSent) {
          fail(new Error("Deepgram realtime stream ended before finalization"));
          return;
        }
        metadataReceived = true;
        return;
      }
      if (payload.type !== "Results") return;
      const channel = payload.channel;
      const alternative: unknown = isObject(channel) && Array.isArray(channel.alternatives) ? channel.alternatives[0] : undefined;
      if (!isObject(alternative) || typeof alternative.transcript !== "string" || typeof payload.is_final !== "boolean"
        || typeof payload.start !== "number" || !Number.isFinite(payload.start) || payload.start < 0
        || typeof payload.duration !== "number" || !Number.isFinite(payload.duration) || payload.duration < 0) {
        fail(new Error("Deepgram returned a malformed realtime transcription response"));
        return;
      }
      const range = `${payload.start}:${payload.duration}`;
      if (finalRanges.has(range)) return;
      if (payload.is_final) finalRanges.add(range);
      const text = alternative.transcript.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
      try { onText({ text, final: payload.is_final }); } catch (error) {
        fail(error instanceof Error ? error : new Error("Deepgram realtime transcript insertion failed"));
      }
    }

    function onSocketError(): void {
      connectionError();
    }

    function onClose(event: Event): void {
      if (!active()) return;
      const close = event as CloseEvent;
      if (state !== "finishing" || !closeSent || !metadataReceived || close.code !== 1000 || !close.wasClean) {
        fail(new Error("Deepgram realtime connection closed before a clean final response"));
        return;
      }
      state = "finished";
      clear(false);
      resolveResult();
    }

    function onAbort(): void {
      stream.cancel();
    }

    async function open(): Promise<void> {
      let key: string;
      try { key = await resolveApiKey(config); } catch (error) {
        fail(error instanceof Error ? error : new Error("Deepgram API key could not be resolved"));
        return;
      }
      if (!active()) return;
      const url = new URL("wss://api.deepgram.com/v1/listen");
      url.searchParams.set("model", config.deepgram.model);
      url.searchParams.set("encoding", "linear16");
      url.searchParams.set("sample_rate", "16000");
      url.searchParams.set("channels", "1");
      url.searchParams.set("interim_results", "true");
      url.searchParams.set("endpointing", "300");
      url.searchParams.set("smart_format", "true");
      url.searchParams.set("language", config.language === "auto" ? "multi" : config.language);
      try { socket = createSocket(url, ["token", key]); } catch { connectionError(); return; }
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onSocketError);
      socket.addEventListener("close", onClose);
    }

    const stream: TranscriptionStream = {
      pushAudio(pcm): void {
        if (state !== "recording" || pcm.byteLength === 0) return;
        if (receivedBytes + pcm.byteLength > maxPcmBytes) {
          fail(new Error(`Microphone audio exceeded the ${config.maxSeconds}-second transcription buffer limit.`));
          return;
        }
        receivedBytes += pcm.byteLength;
        let offset = 0;
        if (pendingByte !== undefined) {
          const pair = Uint8Array.of(pendingByte, pcm[0]!);
          pendingByte = undefined;
          sendAudio(pair);
          offset = 1;
        }
        const end = offset + Math.floor((pcm.byteLength - offset) / 2) * 2;
        while (offset < end && active()) {
          const next = Math.min(end, offset + AUDIO_FRAME_BYTES);
          sendAudio(pcm.subarray(offset, next));
          offset = next;
        }
        if (active() && end < pcm.byteLength) {
          if ((socket?.bufferedAmount ?? 0) + queuedBytes + 1 > MAX_PENDING_BYTES) {
            fail(new Error("Deepgram realtime audio backpressure exceeded the 5-second pending buffer limit"));
            return;
          }
          pendingByte = pcm[end];
        }
      },
      finish(): Promise<void> {
        if (state !== "recording") return result;
        if (receivedBytes % 2 !== 0) {
          fail(new Error("Recorded PCM ends with an incomplete 16-bit sample."));
          return result;
        }
        state = "finishing";
        finishTimer = setTimeout(() => fail(timeoutError("finalization")), config.timeoutMs);
        drain();
        return result;
      },
      cancel(): void {
        if (state === "cancelled" || state === "finished") return;
        state = "cancelled";
        clear(true);
        const error = new Error("Transcription was cancelled.");
        error.name = "AbortError";
        rejectResult(error);
      },
    };
    if (signal.aborted) stream.cancel();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      openingTimer = setTimeout(() => fail(timeoutError("connection opening")), config.timeoutMs);
      void open();
    }
    return stream;
  };
}

export const startDeepgramStream: StartTranscriptionStream = createStartDeepgramStream();
