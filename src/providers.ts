import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider, VoiceConfig } from "./types.ts";

class ProviderError extends Error {}

function label(provider: Provider): string {
  return provider === "groq" ? "Groq" : "Deepgram";
}

export async function resolveApiKey(config: VoiceConfig): Promise<string> {
  const settings = config[config.provider];
  let value = process.env[settings.apiKeyEnv];
  if (value === undefined || !value.trim()) {
    if (!settings.apiKeyFile) {
      throw new ProviderError(`${label(config.provider)} API key is missing; set its configured environment variable or apiKeyFile`);
    }
    const path = settings.apiKeyFile === "~"
      ? homedir()
      : settings.apiKeyFile.startsWith("~/")
        ? join(homedir(), settings.apiKeyFile.slice(2))
        : settings.apiKeyFile;
    try {
      value = await readFile(path, "utf8");
    } catch {
      throw new ProviderError(`${label(config.provider)} API key file could not be read`);
    }
  }
  const key = value.trim();
  if (!key || /\s|[\u0000-\u001f\u007f-\u009f]/.test(key)) {
    throw new ProviderError(`${label(config.provider)} API key must be a single nonempty raw key`);
  }
  return key;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transcript(value: unknown): string {
  if (!isObject(value) || typeof value.text !== "string") {
    throw new ProviderError("Groq returned a malformed transcription response");
  }
  return value.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return "; check API key and account permissions";
  if (status === 413) return "; recording exceeds the provider upload limit";
  if (status === 429) return "; rate or account quota limit reached";
  return "";
}

export async function transcribe(
  audio: Uint8Array,
  config: VoiceConfig,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  signal.throwIfAborted();
  if (config.provider !== "groq") throw new ProviderError("Deepgram requires realtime WebSocket transcription, not phrase uploads");
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = new Error(`${label(config.provider)} transcription timed out`);
  timeout.name = "TimeoutError";
  const timer = setTimeout(() => controller.abort(timeout), config.timeoutMs);
  try {
    const key = await resolveApiKey(config);
    controller.signal.throwIfAborted();
    const wav = new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
    const body = new FormData();
    body.set("file", wav, "recording.wav");
    body.set("model", config.groq.model);
    body.set("response_format", "json");
    if (config.language !== "auto") body.set("language", config.language);
    const response = await fetchImpl("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (!response.ok) {
      throw new ProviderError(`${label(config.provider)} transcription failed (HTTP ${response.status})${statusHint(response.status)}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError(`${label(config.provider)} returned an invalid JSON transcription response`);
    }
    controller.signal.throwIfAborted();
    return transcript(payload);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`${label(config.provider)} transcription request failed; check network connectivity`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
