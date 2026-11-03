import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createStartRecording, encodeWav } from "../src/recorder.ts";
import type { VoiceConfig } from "../src/types.ts";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: unknown;
}

function setup(platform: NodeJS.Platform = "linux") {
  const child = new FakeChild();
  const calls: SpawnCall[] = [];
  const errors: Error[] = [];
  const fakeSpawn = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options });
    return child;
  }) as unknown as typeof spawn;
  const start = createStartRecording(fakeSpawn, platform);
  const config: VoiceConfig = {
    provider: "groq",
    language: "en",
    holdMs: 200,
    releaseMs: 150,
    maxSeconds: 30,
    timeoutMs: 30_000,
    groq: { model: "whisper-large-v3-turbo", apiKeyEnv: "GROQ_API_KEY" },
    deepgram: { model: "nova-3", apiKeyEnv: "DEEPGRAM_API_KEY" },
    capture: { ffmpegPath: "/custom/ffmpeg", device: "default" },
  };
  return { child, calls, errors, start, config };
}

test("encodeWav writes a standard mono 16kHz PCM16 header and exact PCM bytes", () => {
  const pcm = Uint8Array.of(0, 0, 255, 127, 0, 128, 255, 255);
  const wav = encodeWav(pcm);
  const header = Buffer.from(wav.buffer, wav.byteOffset, 44);
  assert.equal(wav.byteLength, 52);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.readUInt32LE(4), 44);
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.toString("ascii", 12, 16), "fmt ");
  assert.equal(header.readUInt32LE(16), 16);
  assert.equal(header.readUInt16LE(20), 1);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16_000);
  assert.equal(header.readUInt32LE(28), 32_000);
  assert.equal(header.readUInt16LE(32), 2);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.toString("ascii", 36, 40), "data");
  assert.equal(header.readUInt32LE(40), pcm.byteLength);
  assert.deepEqual([...wav.subarray(44)], [...pcm]);
  pcm.fill(123);
  assert.deepEqual([...wav.subarray(44)], [0, 0, 255, 127, 0, 128, 255, 255]);
});

test("encodeWav respects a PCM subarray's boundaries", () => {
  const pcm = Uint8Array.of(99, 99, 1, 2, 3, 4, 99, 99).subarray(2, 6);
  const wav = encodeWav(pcm);
  assert.equal(wav.byteLength, 48);
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
});

test("encodeWav rejects empty audio and incomplete PCM samples", () => {
  assert.throws(() => encodeWav(new Uint8Array()), /No microphone audio/);
  assert.throws(() => encodeWav(Uint8Array.of(1)), /incomplete 16-bit sample/);
  assert.throws(() => encodeWav(Uint8Array.of(1, 2, 3)), /incomplete 16-bit sample/);
});

test("Linux capture uses Pulse, raw mono PCM16, and array arguments without a shell", () => {
  const fixture = setup();
  const { config, start, calls } = fixture;
  config.capture.device = "source with spaces; $(not-a-command)";
  const recording = start(config, (error) => fixture.errors.push(error));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "/custom/ffmpeg");
  assert.deepEqual(calls[0]!.args, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "pulse", "-i", "source with spaces; $(not-a-command)",
    "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ]);
  assert.deepEqual(calls[0]!.options, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  recording.cancel();
});

test("Linux defaults to the default Pulse source", () => {
  const fixture = setup();
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  assert.deepEqual(fixture.calls[0]!.args.slice(4, 8), ["-f", "pulse", "-i", "default"]);
  recording.cancel();
});

test("macOS default maps to audio-only avfoundation :0 and custom devices pass through", () => {
  for (const [device, expected] of [["default", ":0"], [":2", ":2"]]) {
    const fixture = setup("darwin");
    fixture.config.capture.device = device!;
    const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
    assert.deepEqual(fixture.calls[0]!.args.slice(4, 8), ["-f", "avfoundation", "-i", expected]);
    recording.cancel();
  }
});

test("Windows requires a named DirectShow device and unsupported platforms fail explicitly", () => {
  const windows = setup("win32");
  assert.throws(() => windows.start(windows.config, () => {}), /explicit DirectShow audio device/);
  assert.equal(windows.calls.length, 0);
  windows.config.capture.device = "Microphone (USB Audio)";
  const recording = windows.start(windows.config, (error) => windows.errors.push(error));
  assert.deepEqual(windows.calls[0]!.args.slice(4, 8), ["-f", "dshow", "-i", "audio=Microphone (USB Audio)"]);
  recording.cancel();
  const unsupported = setup("freebsd");
  assert.throws(() => unsupported.start(unsupported.config, () => {}), /not supported on freebsd/);
  assert.equal(unsupported.calls.length, 0);
});

test("invalid recording durations are rejected before spawning", () => {
  for (const maxSeconds of [0, -1, 301, Infinity, NaN]) {
    const fixture = setup();
    fixture.config.maxSeconds = maxSeconds;
    assert.throws(() => fixture.start(fixture.config, () => {}), /maxSeconds/);
    assert.equal(fixture.calls.length, 0);
  }
});

test("stop is idempotent, includes flushed samples, and accepts ffmpeg SIGINT exit 255", async () => {
  const fixture = setup();
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  fixture.child.stdout.write(Buffer.from([1, 2, 3]));
  const stopped = recording.stop();
  assert.equal(recording.stop(), stopped);
  assert.deepEqual(fixture.child.signals, ["SIGINT"]);
  fixture.child.stdout.write(Buffer.from([4, 5, 6]));
  fixture.child.close(255);
  const wav = await stopped;
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4, 5, 6]);
  assert.equal(recording.stop(), stopped);
  recording.cancel();
  assert.deepEqual(fixture.child.signals, ["SIGINT"]);
  assert.deepEqual(fixture.errors, []);
});

test("stop accepts a normal exit or a SIGINT termination only after it requested shutdown", async () => {
  for (const [code, signal] of [[0, null], [null, "SIGINT"]] as const) {
    const fixture = setup();
    const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
    fixture.child.stdout.write(Buffer.from([1, 2]));
    const stopped = recording.stop();
    fixture.child.close(code, signal);
    assert.deepEqual([...(await stopped).subarray(44)], [1, 2]);
    assert.deepEqual(fixture.errors, []);
  }
});

test("stop rejects empty audio, incomplete samples, and abnormal ffmpeg exits", async () => {
  for (const scenario of [
    { pcm: [], code: 0, message: /No microphone audio/ },
    { pcm: [1, 2, 3], code: 0, message: /incomplete 16-bit sample/ },
    { pcm: [1, 2], code: 1, message: /code 1: microphone unavailable/ },
  ]) {
    const fixture = setup();
    const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
    fixture.child.stdout.write(Buffer.from(scenario.pcm));
    fixture.child.stderr.write("microphone unavailable\n");
    const stopped = recording.stop();
    fixture.child.close(scenario.code);
    await assert.rejects(stopped, scenario.message);
    assert.equal(fixture.errors.length, 1);
  }
});

test("unexpected early exits report once and cannot return partial audio", async () => {
  for (const code of [0, 255, 1]) {
    const fixture = setup();
    const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
    fixture.child.stdout.write(Buffer.from([1, 2]));
    fixture.child.close(code);
    fixture.child.emit("error", new Error("late process error"));
    await assert.rejects(recording.stop(), /ffmpeg microphone capture exited/);
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.child.stdout.destroyed, true);
  }
});

test("asynchronous spawn and capture-stream errors reject stop and report only once", async () => {
  for (const source of ["process", "stdout", "stderr"]) {
    const fixture = setup();
    const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
    const error = new Error(source === "process" ? "spawn ffmpeg ENOENT" : "capture pipe failed");
    if (source === "process") fixture.child.emit("error", error);
    else if (source === "stdout") fixture.child.stdout.emit("error", error);
    else fixture.child.stderr.emit("error", error);
    fixture.child.emit("error", new Error("duplicate error"));
    await assert.rejects(recording.stop(), (failure) => failure === error);
    assert.deepEqual(fixture.errors, [error]);
    assert.deepEqual(fixture.child.signals, ["SIGKILL"]);
  }
});

test("a synchronous spawn failure is retained without an unhandled rejected result", async () => {
  const fixture = setup();
  const error = new Error("spawn failed synchronously");
  const failingSpawn = (() => { throw error; }) as unknown as typeof spawn;
  const start = createStartRecording(failingSpawn, "linux");
  const recording = start(fixture.config, (failure) => fixture.errors.push(failure));
  await Promise.resolve();
  assert.deepEqual(fixture.errors, [error]);
  await assert.rejects(recording.stop(), (failure) => failure === error);
});

test("cancel discards pending stop data, kills only its child, and suppresses late callbacks", async () => {
  const fixture = setup();
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  fixture.child.stdout.write(Buffer.from([1, 2]));
  const stopped = recording.stop();
  recording.cancel();
  recording.cancel();
  fixture.child.emit("error", new Error("late spawn error"));
  fixture.child.stdout.emit("error", new Error("late stdout error"));
  fixture.child.stderr.emit("error", new Error("late stderr error"));
  fixture.child.close(null, "SIGKILL");
  await assert.rejects(stopped, { name: "AbortError" });
  assert.equal(recording.stop(), stopped);
  assert.deepEqual(fixture.child.signals, ["SIGINT", "SIGKILL"]);
  assert.equal(fixture.child.stdout.destroyed, true);
  assert.equal(fixture.child.stderr.destroyed, true);
  assert.deepEqual(fixture.errors, []);
});

test("cancelling immediately before an error callback suppresses the callback", async () => {
  const fixture = setup();
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  fixture.child.emit("error", new Error("microphone unavailable"));
  recording.cancel();
  await Promise.resolve();
  assert.deepEqual(fixture.errors, []);
  await assert.rejects(recording.stop(), /microphone unavailable/);
});

test("hitting the PCM buffer cap fails rather than returning or uploading a partial recording", async () => {
  const fixture = setup();
  fixture.config.maxSeconds = 1;
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  fixture.child.stdout.write(Buffer.alloc(32_000));
  await assert.rejects(recording.stop(), /recording buffer limit/);
  assert.equal(fixture.errors.length, 1);
  assert.deepEqual(fixture.child.signals, ["SIGKILL"]);
});

test("duration deadline fails and kills capture even if the microphone never produces audio", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup();
  fixture.config.maxSeconds = 1;
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  context.mock.timers.tick(999);
  assert.deepEqual(fixture.child.signals, []);
  context.mock.timers.tick(1);
  await assert.rejects(recording.stop(), /duration limit/);
  assert.equal(fixture.errors.length, 1);
  assert.deepEqual(fixture.child.signals, ["SIGKILL"]);
});

test("stalled graceful shutdown escalates to SIGKILL and rejects instead of hanging", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup();
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error));
  fixture.child.stdout.write(Buffer.from([1, 2]));
  const stopped = recording.stop();
  context.mock.timers.tick(1_499);
  assert.deepEqual(fixture.child.signals, ["SIGINT"]);
  context.mock.timers.tick(1);
  await assert.rejects(stopped, /shutdown deadline/);
  assert.deepEqual(fixture.child.signals, ["SIGINT", "SIGKILL"]);
  assert.equal(fixture.errors.length, 1);
  fixture.child.close(null, "SIGKILL");
  assert.equal(fixture.errors.length, 1);
});

test("raw PCM callbacks receive every recording and stopping chunk without changing the final WAV", async () => {
  const fixture = setup();
  const audio: Uint8Array[] = [];
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error), (chunk) => audio.push(chunk));
  const first = Buffer.from([1, 2, 3]);
  const flushed = Buffer.from([4, 5, 6]);
  fixture.child.stdout.write(first);
  assert.equal(audio[0], first);
  const stopped = recording.stop();
  fixture.child.stdout.write(flushed);
  assert.equal(audio[1], flushed);
  fixture.child.close(255);
  assert.deepEqual([...(await stopped).subarray(44)], [1, 2, 3, 4, 5, 6]);
  fixture.child.stdout.emit("data", Buffer.from([7, 8]));
  assert.equal(audio.length, 2);
  assert.deepEqual(fixture.errors, []);
});

test("raw PCM callback failures abort capture and reject stop exactly once", async () => {
  const fixture = setup();
  const error = new Error("Transcription audio consumer failed.");
  let calls = 0;
  const recording = fixture.start(fixture.config, (failure) => fixture.errors.push(failure), () => {
    calls++;
    throw error;
  });
  assert.doesNotThrow(() => fixture.child.stdout.write(Buffer.from([1, 2])));
  fixture.child.stdout.emit("data", Buffer.from([3, 4]));
  await assert.rejects(recording.stop(), (failure) => failure === error);
  assert.equal(calls, 1);
  assert.deepEqual(fixture.errors, [error]);
  assert.deepEqual(fixture.child.signals, ["SIGKILL"]);
});

test("cancellation stops raw PCM publication including buffered late stdout events", async () => {
  const fixture = setup();
  const audio: Uint8Array[] = [];
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error), (chunk) => audio.push(chunk));
  fixture.child.stdout.write(Buffer.from([1, 2]));
  recording.cancel();
  fixture.child.stdout.emit("data", Buffer.from([3, 4]));
  fixture.child.close(null, "SIGKILL");
  await assert.rejects(recording.stop(), { name: "AbortError" });
  assert.equal(audio.length, 1);
  assert.deepEqual(fixture.errors, []);
});

test("PCM chunks exceeding the recording cap are not published as partial valid audio", async () => {
  const fixture = setup();
  fixture.config.maxSeconds = 1;
  const audio: Uint8Array[] = [];
  const recording = fixture.start(fixture.config, (error) => fixture.errors.push(error), (chunk) => audio.push(chunk));
  fixture.child.stdout.write(Buffer.alloc(32_000));
  await assert.rejects(recording.stop(), /recording buffer limit/);
  assert.deepEqual(audio, []);
  assert.equal(fixture.errors.length, 1);
});
