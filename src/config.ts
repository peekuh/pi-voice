import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider, VoiceConfig } from "./types.ts";

const DEFAULTS: VoiceConfig = {
  provider: "deepgram",
  language: "en",
  holdMs: 600,
  releaseMs: 250,
  maxSeconds: 120,
  timeoutMs: 30_000,
  groq: { model: "whisper-large-v3-turbo", apiKeyEnv: "GROQ_API_KEY" },
  deepgram: { model: "nova-3", apiKeyEnv: "DEEPGRAM_API_KEY" },
  capture: { ffmpegPath: "ffmpeg", device: "default" },
};

const ROOT_KEYS = Object.keys(DEFAULTS);
const PROVIDER_KEYS = ["model", "apiKeyEnv", "apiKeyFile"];
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, field: string, keys: string[]): ObjectValue {
  if (!isObject(value)) {
    throw new Error(`Invalid voice config: ${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Invalid voice config: unknown key in ${field}`);
  }
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value || value.length > 4096 || CONTROL.test(value)) {
    throw new Error(`Invalid voice config: ${field} must be a nonempty string without surrounding whitespace or controls`);
  }
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid voice config: ${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function provider(value: unknown): Provider {
  if (value !== "groq" && value !== "deepgram") throw new Error("Invalid voice config: provider must be groq or deepgram");
  return value;
}

function providerConfig(value: unknown, name: Provider): VoiceConfig[Provider] {
  const input = value === undefined ? {} : object(value, name, PROVIDER_KEYS);
  const result = { ...DEFAULTS[name] };
  if (Object.hasOwn(input, "model")) {
    result.model = string(input.model, `${name}.model`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(result.model)) {
      throw new Error(`Invalid voice config: ${name}.model must be a model identifier`);
    }
  }
  if (Object.hasOwn(input, "apiKeyEnv")) {
    result.apiKeyEnv = string(input.apiKeyEnv, `${name}.apiKeyEnv`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.apiKeyEnv)) {
      throw new Error(`Invalid voice config: ${name}.apiKeyEnv must be an environment variable name`);
    }
  }
  if (Object.hasOwn(input, "apiKeyFile")) result.apiKeyFile = string(input.apiKeyFile, `${name}.apiKeyFile`);
  return result;
}

function validate(value: unknown): VoiceConfig {
  const input = object(value, "root", ROOT_KEYS);
  const result: VoiceConfig = {
    ...DEFAULTS,
    groq: providerConfig(input.groq, "groq"),
    deepgram: providerConfig(input.deepgram, "deepgram"),
    capture: { ...DEFAULTS.capture },
  };
  if (Object.hasOwn(input, "provider")) result.provider = provider(input.provider);
  if (Object.hasOwn(input, "language")) {
    result.language = string(input.language, "language");
    if (result.language !== "auto" && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(result.language)) {
      throw new Error("Invalid voice config: language must be auto or a language tag such as en or en-US");
    }
  }
  if (Object.hasOwn(input, "holdMs")) result.holdMs = integer(input.holdMs, "holdMs", 100, 5000);
  if (Object.hasOwn(input, "releaseMs")) result.releaseMs = integer(input.releaseMs, "releaseMs", 50, 2000);
  if (Object.hasOwn(input, "maxSeconds")) result.maxSeconds = integer(input.maxSeconds, "maxSeconds", 1, 300);
  if (Object.hasOwn(input, "timeoutMs")) result.timeoutMs = integer(input.timeoutMs, "timeoutMs", 1000, 300_000);
  if (Object.hasOwn(input, "capture")) {
    const capture = object(input.capture, "capture", ["ffmpegPath", "device"]);
    if (Object.hasOwn(capture, "ffmpegPath")) result.capture.ffmpegPath = string(capture.ffmpegPath, "capture.ffmpegPath");
    if (Object.hasOwn(capture, "device")) result.capture.device = string(capture.device, "capture.device");
  }
  return result;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function configPath(): string {
  const override = process.env.PI_VOICE_CONFIG;
  return override ? expandHome(override) : join(homedir(), ".config", "pi-voice", "config.json");
}

async function readConfig(path: string): Promise<ObjectValue> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    throw new Error("Unable to read voice config file");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid voice config: malformed JSON");
  }
  const input = object(value, "root", ROOT_KEYS);
  validate(input);
  return input;
}

export async function loadConfig(path: string = configPath()): Promise<VoiceConfig> {
  return validate(await readConfig(expandHome(path)));
}

export async function saveProvider(value: Provider): Promise<void> {
  const selected = provider(value);
  const path = configPath();
  const current = await readConfig(path);
  const temporary = join(dirname(path), `.pi-voice-${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify({ ...current, provider: selected }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    throw new Error("Unable to save voice provider configuration");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
