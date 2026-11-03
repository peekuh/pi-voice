import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test, type TestContext } from "node:test";
import { createStartDeepgramStream, type DeepgramSocket } from "../src/deepgram.ts";
import type { TranscriptUpdate, VoiceConfig } from "../src/types.ts";

const KEY = "fixture-deepgram-key-not-a-credential";
let fixtureId = 0;

class FakeSocket extends EventTarget implements DeepgramSocket {
  readyState = 0;
  bufferedAmount = 0;
  holdWrites = false;
  sendError: Error | undefined;
  sent: (string | Uint8Array)[] = [];
  closeCalls = 0;

  send(data: string | Uint8Array): void {
    if (this.sendError) throw this.sendError;
    assert.equal(this.readyState, 1);
    this.sent.push(typeof data === "string" ? data : data.slice());
    if (this.holdWrites) this.bufferedAmount += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) }));
  }

  serverClose(code = 1000, wasClean = true, reason = ""): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, wasClean, reason }));
  }
}

function results(text: string, final: boolean, start = 0, duration = 1, speechFinal = false): unknown {
  return {
    type: "Results", start, duration, is_final: final, speech_final: speechFinal,
    channel: { alternatives: [{ transcript: text }] },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function setup(context: TestContext, overrides: Partial<VoiceConfig> = {}) {
  const keyEnv = `PI_VOICE_REALTIME_FIXTURE_${process.pid}_${++fixtureId}`;
  assert.equal(Object.hasOwn(process.env, keyEnv), false);
  process.env[keyEnv] = KEY;
  const config: VoiceConfig = {
    provider: "deepgram", language: "en", holdMs: 600, releaseMs: 150, maxSeconds: 30, timeoutMs: 30_000,
    groq: { model: "whisper-large-v3-turbo", apiKeyEnv: "UNUSED_GROQ_KEY" },
    deepgram: { model: "nova-3", apiKeyEnv: keyEnv },
    capture: { ffmpegPath: "ffmpeg", device: "default" },
    cursor: { enabled: true, reducedMotion: false },
    ...overrides,
  };
  const socket = new FakeSocket();
  const connections: { url: URL; protocols: string[] }[] = [];
  const transport: { error?: Error } = {};
  const updates: TranscriptUpdate[] = [];
  const errors: Error[] = [];
  const source = new AbortController();
  const start = createStartDeepgramStream((url, protocols) => {
    connections.push({ url, protocols });
    if (transport.error) throw transport.error;
    return socket;
  });
  const stream = start(config, source.signal, (update) => updates.push(update), (error) => errors.push(error));
  context.after(() => { stream.cancel(); delete process.env[keyEnv]; });
  return { config, socket, connections, transport, updates, errors, source, start, stream, keyEnv };
}

test("key resolution and socket opening buffer PCM, then authenticate a fixed TLS realtime endpoint", async (context) => {
  const fixture = setup(context);
  const audio = Uint8Array.of(1, 2, 3, 4);
  fixture.stream.pushAudio(audio);
  audio.fill(99);
  assert.equal(fixture.connections.length, 0);
  await settle();
  assert.equal(fixture.connections.length, 1);
  const connection = fixture.connections[0]!;
  assert.deepEqual(connection.protocols, ["token", KEY]);
  assert.equal(connection.url.origin, "wss://api.deepgram.com");
  assert.equal(connection.url.pathname, "/v1/listen");
  assert.deepEqual(Object.fromEntries(connection.url.searchParams), {
    model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1",
    interim_results: "true", endpointing: "300", smart_format: "true", language: "en",
  });
  assert.doesNotMatch(connection.url.href, /fixture-deepgram-key|api_key|access_token|detect_language/);
  fixture.stream.pushAudio(Uint8Array.of(5, 6));
  assert.deepEqual(fixture.socket.sent, []);
  fixture.socket.open();
  assert.deepEqual(Buffer.concat(fixture.socket.sent as Uint8Array[]), Buffer.from([1, 2, 3, 4, 5, 6]));
  const finished = fixture.stream.finish();
  fixture.socket.message({ type: "Metadata" });
  fixture.socket.serverClose();
  await finished;
  assert.deepEqual(fixture.errors, []);
});

test("automatic language selects realtime multi and never prerecorded detection", async (context) => {
  const fixture = setup(context, { language: "auto" });
  fixture.config.deepgram.model = "nova-2";
  await settle();
  const url = fixture.connections[0]!.url;
  assert.equal(url.searchParams.get("language"), "multi");
  assert.equal(url.searchParams.get("model"), "nova-2");
  assert.equal(url.searchParams.has("detect_language"), false);
});

test("silence and continuous speech send raw PCM immediately without a pause, WAV or finish", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  const chunks = [Buffer.alloc(3_200), Buffer.alloc(3_200, 40), Buffer.alloc(3_200, 90)];
  for (let index = 0; index < chunks.length; index++) {
    fixture.stream.pushAudio(chunks[index]!);
    assert.equal(fixture.socket.sent.length, index + 1);
    assert.deepEqual(fixture.socket.sent[index], chunks[index]);
  }
  assert.equal(fixture.socket.sent.some((data) => typeof data === "string"), false);
  fixture.socket.message(results("Already live", false));
  assert.deepEqual(fixture.updates, [{ text: "Already live", final: false }]);
});

test("arbitrary odd byte boundaries preserve sample order without sending incomplete samples", async (context) => {
  const fixture = setup(context);
  const audio = Uint8Array.from({ length: 1_024 }, (_, index) => index % 256);
  fixture.stream.pushAudio(audio.subarray(0, 137));
  await settle();
  fixture.socket.open();
  for (let offset = 137; offset < audio.byteLength; offset += 137) {
    fixture.stream.pushAudio(audio.subarray(offset, offset + 137));
  }
  const frames = fixture.socket.sent as Uint8Array[];
  assert.ok(frames.every((frame) => frame.byteLength % 2 === 0));
  assert.deepEqual(Buffer.concat(frames), Buffer.from(audio));
  const finished = fixture.stream.finish();
  fixture.socket.message({ type: "Metadata" });
  fixture.socket.serverClose();
  await finished;
});

test("interim hypotheses revise in place and is_final commits independently of speech_final", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.message(results("I scream", false, 0, 0.5));
  fixture.socket.message(results("Ice cream", false, 0, 1, true));
  fixture.socket.message(results("Ice cream.", true, 0, 1, false));
  fixture.socket.message(results("Next", false, 1, 0.5));
  fixture.socket.message(results("Next segment.", true, 1, 1, true));
  assert.deepEqual(fixture.updates, [
    { text: "I scream", final: false }, { text: "Ice cream", final: false },
    { text: "Ice cream.", final: true }, { text: "Next", final: false }, { text: "Next segment.", final: true },
  ]);
});

test("final time ranges commit once but intentional repeated text at new ranges is retained", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.message(results("Again.", true, 0, 1));
  fixture.socket.message(results("Next hypothesis", false, 1, 1));
  fixture.socket.message(results("Different text for the same committed range", true, 0, 1, true));
  fixture.socket.message(results("Late interim for an already committed range", false, 0, 1));
  fixture.socket.message(results("Again.", true, 1, 1));
  fixture.socket.message(results("Again.", true, 2, 1));
  assert.deepEqual(fixture.updates, [
    { text: "Again.", final: true }, { text: "Next hypothesis", final: false },
    { text: "Again.", final: true }, { text: "Again.", final: true },
  ]);
});

test("empty final clears a pending hypothesis and transcript controls never reach the editor", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.message(results("Uncertain", false));
  fixture.socket.message(results("", true));
  fixture.socket.message(results("Hello\nworld\t\u001b[31m\r\u0000\u007f\u0085!", true, 1));
  assert.deepEqual(fixture.updates, [
    { text: "Uncertain", final: false }, { text: "", final: true }, { text: "Hello\nworld\t[31m!", final: true },
  ]);
});

test("finish waits for all queued and native-buffered PCM before CloseStream and preserves server finals", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup(context);
  fixture.socket.holdWrites = true;
  await settle();
  fixture.socket.open();
  const audio = Buffer.alloc(80_000, 42);
  fixture.stream.pushAudio(audio);
  assert.equal(Buffer.concat(fixture.socket.sent as Uint8Array[]).byteLength, 64_000);
  const finished = fixture.stream.finish();
  assert.equal(fixture.stream.finish(), finished);
  let completed = false;
  void finished.then(() => { completed = true; });
  fixture.socket.message(results("Tail preview", false));
  assert.equal(fixture.socket.sent.some((frame) => typeof frame === "string"), false);
  fixture.socket.bufferedAmount = 0;
  context.mock.timers.tick(20);
  assert.deepEqual(Buffer.concat(fixture.socket.sent as Uint8Array[]), audio);
  assert.equal(fixture.socket.sent.some((frame) => typeof frame === "string"), false);
  fixture.socket.bufferedAmount = 0;
  context.mock.timers.tick(20);
  assert.equal(fixture.socket.sent.at(-1), '{"type":"CloseStream"}');
  fixture.stream.pushAudio(Uint8Array.of(1, 2));
  fixture.socket.message(results("Tail final.", true));
  fixture.socket.message({ type: "Metadata" });
  await settle();
  assert.equal(completed, false);
  fixture.socket.serverClose();
  await finished;
  assert.equal(completed, true);
  assert.deepEqual(fixture.updates, [{ text: "Tail preview", final: false }, { text: "Tail final.", final: true }]);
  assert.equal(fixture.socket.closeCalls, 0);
  assert.deepEqual(fixture.errors, []);
});

test("finish before key/socket opening retains PCM, closes once and waits for the server", async (context) => {
  const fixture = setup(context);
  fixture.stream.pushAudio(Uint8Array.of(8, 9));
  const finished = fixture.stream.finish();
  fixture.stream.pushAudio(Uint8Array.of(10, 11));
  await settle();
  fixture.socket.open();
  assert.deepEqual(fixture.socket.sent, [Uint8Array.of(8, 9), '{"type":"CloseStream"}']);
  fixture.socket.message(results("Released before opening.", true));
  fixture.socket.message({ type: "Metadata" });
  fixture.socket.serverClose();
  await finished;
  assert.equal(fixture.stream.finish(), finished);
  assert.deepEqual(fixture.updates, [{ text: "Released before opening.", final: true }]);
  fixture.stream.cancel();
  assert.equal(fixture.socket.closeCalls, 0);
});

test("idle streams use text KeepAlive, audio resets it, and finalization stops it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  context.mock.timers.tick(3_999);
  assert.deepEqual(fixture.socket.sent, []);
  context.mock.timers.tick(1);
  assert.deepEqual(fixture.socket.sent, ['{"type":"KeepAlive"}']);
  context.mock.timers.tick(3_000);
  fixture.stream.pushAudio(Uint8Array.of(1, 2));
  context.mock.timers.tick(1_000);
  assert.equal(fixture.socket.sent.length, 2);
  context.mock.timers.tick(3_000);
  assert.equal(fixture.socket.sent.at(-1), '{"type":"KeepAlive"}');
  const finished = fixture.stream.finish();
  context.mock.timers.tick(8_000);
  assert.equal(fixture.socket.sent.at(-1), '{"type":"CloseStream"}');
  assert.equal(fixture.socket.sent.length, 4);
  fixture.socket.message({ type: "Metadata" });
  fixture.socket.serverClose();
  await finished;
});

test("cancelling during key resolution and already-aborted starts never construct a socket", async (context) => {
  const fixture = setup(context);
  fixture.stream.pushAudio(Uint8Array.of(1, 2));
  fixture.stream.cancel();
  await assert.rejects(fixture.stream.finish(), { name: "AbortError" });
  fixture.source.abort();
  const second = fixture.start(fixture.config, fixture.source.signal, () => assert.fail("late text"), () => assert.fail("late error"));
  second.pushAudio(Uint8Array.of(1, 2));
  await assert.rejects(second.finish(), { name: "AbortError" });
  await settle();
  assert.deepEqual(fixture.connections, []);
  assert.deepEqual(fixture.errors, []);
});

test("cancelling a connecting socket drops queued PCM and suppresses every late event", async (context) => {
  const fixture = setup(context);
  fixture.stream.pushAudio(Uint8Array.of(1, 2));
  await settle();
  fixture.stream.cancel();
  fixture.stream.cancel();
  await assert.rejects(fixture.stream.finish(), { name: "AbortError" });
  assert.equal(fixture.socket.closeCalls, 1);
  fixture.socket.open();
  fixture.socket.message(results("Never inserted", true));
  fixture.socket.dispatchEvent(new Event("error"));
  fixture.socket.serverClose();
  await settle();
  assert.deepEqual(fixture.socket.sent, []);
  assert.deepEqual(fixture.updates, []);
  assert.deepEqual(fixture.errors, []);
});

for (const phase of ["recording", "draining", "closing"] as const) {
  test(`external cancellation while ${phase} clears timers and suppresses late finals`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = setup(context);
    await settle();
    fixture.socket.open();
    fixture.socket.message(results("Already committed.", true));
    fixture.socket.holdWrites = phase === "draining";
    fixture.stream.pushAudio(Buffer.alloc(phase === "draining" ? 80_000 : 2));
    const finished = phase === "recording" ? undefined : fixture.stream.finish();
    const sentAtCancel = fixture.socket.sent.length;
    fixture.source.abort(new Error("caller cancellation"));
    await assert.rejects(finished ?? fixture.stream.finish(), { name: "AbortError" });
    fixture.socket.bufferedAmount = 0;
    context.mock.timers.tick(60_000);
    fixture.socket.message(results("Late final", true, 1));
    fixture.socket.message({ type: "Metadata" });
    fixture.socket.serverClose();
    assert.equal(fixture.socket.sent.length, sentAtCancel);
    assert.deepEqual(fixture.updates, [{ text: "Already committed.", final: true }]);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.socket.closeCalls, 1);
  });
}

test("connection opening timeout rejects, closes the socket and never retries", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup(context, { timeoutMs: 25 });
  await settle();
  context.mock.timers.tick(25);
  await assert.rejects(fixture.stream.finish(), { name: "TimeoutError", message: "Deepgram realtime connection opening timed out" });
  fixture.socket.open();
  context.mock.timers.tick(60_000);
  assert.equal(fixture.connections.length, 1);
  assert.equal(fixture.socket.closeCalls, 1);
  assert.deepEqual(fixture.socket.sent, []);
  assert.equal(fixture.errors.length, 1);
});

for (const phase of ["draining", "metadata", "server-close"] as const) {
  test(`finish deadline bounds waiting for ${phase}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = setup(context, { timeoutMs: 100 });
    await settle();
    fixture.socket.open();
    if (phase === "draining") {
      fixture.socket.holdWrites = true;
      fixture.stream.pushAudio(Buffer.alloc(80_000));
    }
    const finished = fixture.stream.finish();
    if (phase === "server-close") fixture.socket.message({ type: "Metadata" });
    context.mock.timers.tick(100);
    await assert.rejects(finished, { name: "TimeoutError", message: "Deepgram realtime finalization timed out" });
    assert.equal(fixture.socket.closeCalls, 1);
    assert.equal(fixture.errors.length, 1);
  });
}

test("a clean server close while still recording is premature even after a committed segment", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.message(results("Keep this.", true));
  fixture.socket.serverClose();
  await assert.rejects(fixture.stream.finish(), /before a clean final response/);
  assert.deepEqual(fixture.updates, [{ text: "Keep this.", final: true }]);
  assert.equal(fixture.errors.length, 1);
});

for (const close of [
  { code: 1006, clean: false, metadata: true },
  { code: 1008, clean: true, metadata: true },
  { code: 1000, clean: false, metadata: true },
  { code: 1000, clean: true, metadata: false },
]) {
  test(`finish rejects code ${close.code}, clean=${close.clean}, metadata=${close.metadata} without exposing close reasons`, async (context) => {
    const fixture = setup(context);
    await settle();
    fixture.socket.open();
    const finished = fixture.stream.finish();
    if (close.metadata) fixture.socket.message({ type: "Metadata" });
    fixture.socket.serverClose(close.code, close.clean, `${KEY}\u001bprivate-close-reason`);
    await assert.rejects(finished, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /before a clean final response/);
      assert.doesNotMatch(error.message, /fixture-deepgram-key|private-close-reason|\u001b/);
      return true;
    });
    assert.equal(fixture.errors.length, 1);
  });
}

for (const phase of ["construct", "opening", "send", "recording", "closing", "provider"] as const) {
  test(`${phase} errors are secret-safe, report once and never retry or fall back`, async (context) => {
    const fixture = setup(context);
    const privateError = new Error(`wss://private.invalid/?key=${KEY}\nprivate-websocket-error\u001b`);
    if (phase === "construct") fixture.transport.error = privateError;
    await settle();
    if (phase !== "construct") {
      if (phase !== "opening") fixture.socket.open();
      if (phase === "send") {
        fixture.socket.sendError = privateError;
        fixture.stream.pushAudio(Uint8Array.of(1, 2));
      } else if (phase === "provider") {
        fixture.socket.message({ type: "Error", description: privateError.message, message: privateError.message });
      } else {
        if (phase === "closing") void fixture.stream.finish();
        fixture.socket.dispatchEvent(Object.assign(new Event("error"), { error: privateError, message: privateError.message }));
      }
    }
    await assert.rejects(fixture.stream.finish(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Deepgram realtime/);
      assert.doesNotMatch(error.message, /fixture-deepgram-key|private-websocket-error|private.invalid|[\u0000-\u001f]/);
      return true;
    });
    fixture.socket.message(results("Late", true));
    await settle();
    assert.equal(fixture.connections.length, 1);
    assert.equal(fixture.errors.length, 1);
    assert.deepEqual(fixture.updates, []);
  });
}

test("missing and invalid keys fail before WebSocket construction", async (context) => {
  for (const key of [undefined, "private key\u001b"]) {
    const fixture = setup(context);
    fixture.stream.cancel();
    if (key === undefined) delete process.env[fixture.keyEnv];
    else process.env[fixture.keyEnv] = key;
    const stream = fixture.start(fixture.config, fixture.source.signal, (update) => fixture.updates.push(update), (error) => fixture.errors.push(error));
    context.after(() => stream.cancel());
    await assert.rejects(stream.finish(), /Deepgram API key/);
    assert.deepEqual(fixture.connections, []);
    assert.equal(fixture.errors.length, 1);
    assert.doesNotMatch(fixture.errors[0]!.message, /private key|\u001b/);
  }
});

test("invalid JSON and malformed realtime fields reject without echoing provider data", async (context) => {
  const malformed: unknown[] = [
    null, {}, { type: "Results" }, { type: "Results", channel: { alternatives: [{ transcript: KEY }] } },
    { type: "Results", start: -1, duration: 1, is_final: true, channel: { alternatives: [{ transcript: KEY }] } },
    { type: "Results", start: 0, duration: 1, is_final: "true", channel: { alternatives: [{ transcript: KEY }] } },
    { type: "Results", start: 0, duration: 1, is_final: true, channel: { alternatives: [{ transcript: 123 }] } },
  ];
  for (const value of malformed) {
    const fixture = setup(context);
    await settle();
    fixture.socket.open();
    fixture.socket.message(value);
    await assert.rejects(fixture.stream.finish(), /malformed realtime/);
    assert.deepEqual(fixture.updates, []);
    assert.doesNotMatch(fixture.errors[0]!.message, /fixture-deepgram-key/);
  }
  for (const data of [`not-json-${KEY}\u001b`, Uint8Array.of(1, 2)]) {
    const fixture = setup(context);
    await settle();
    fixture.socket.open();
    fixture.socket.dispatchEvent(Object.assign(new Event("message"), { data }));
    await assert.rejects(fixture.stream.finish(), /invalid JSON realtime/);
    assert.doesNotMatch(fixture.errors[0]!.message, /fixture-deepgram-key|\u001b/);
  }
});

test("metadata before CloseStream is an unexpected server termination", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.message({ type: "Metadata" });
  await assert.rejects(fixture.stream.finish(), /ended before finalization/);
});

test("maxSeconds bounds already-sent silence as well as queued audio", async (context) => {
  const fixture = setup(context, { maxSeconds: 1 });
  await settle();
  fixture.socket.open();
  fixture.stream.pushAudio(Buffer.alloc(32_000));
  assert.equal(Buffer.concat(fixture.socket.sent as Uint8Array[]).byteLength, 32_000);
  fixture.stream.pushAudio(Uint8Array.of(0, 0));
  await assert.rejects(fixture.stream.finish(), /1-second transcription buffer limit/);
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.socket.closeCalls, 1);
});

test("opening PCM queue has a five-second bound instead of retaining the whole recording", async (context) => {
  const fixture = setup(context);
  fixture.stream.pushAudio(Buffer.alloc(160_000));
  fixture.stream.pushAudio(Uint8Array.of(1, 2));
  await assert.rejects(fixture.stream.finish(), /backpressure.*5-second pending buffer limit/);
  await settle();
  assert.deepEqual(fixture.connections, []);
  assert.equal(fixture.errors.length, 1);
});

test("socket bufferedAmount participates in the pending buffer cap", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.bufferedAmount = 160_000;
  fixture.stream.pushAudio(Uint8Array.of(1, 2));
  await assert.rejects(fixture.stream.finish(), /backpressure/);
  assert.deepEqual(fixture.socket.sent, []);
  assert.equal(fixture.socket.closeCalls, 1);
});

test("backpressured PCM resumes in byte order while still recording", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.socket.holdWrites = true;
  const audio = Uint8Array.from({ length: 80_000 }, (_, index) => index % 256);
  fixture.stream.pushAudio(audio);
  assert.equal(Buffer.concat(fixture.socket.sent as Uint8Array[]).byteLength, 64_000);
  fixture.socket.bufferedAmount = 0;
  context.mock.timers.tick(20);
  assert.deepEqual(Buffer.concat(fixture.socket.sent as Uint8Array[]), Buffer.from(audio));
  assert.equal(fixture.socket.sent.some((frame) => typeof frame === "string"), false);
  assert.deepEqual(fixture.errors, []);
});

test("odd total sample finalization rejects rather than sending CloseStream or corrupt PCM", async (context) => {
  const fixture = setup(context);
  await settle();
  fixture.socket.open();
  fixture.stream.pushAudio(Uint8Array.of(1, 2, 3));
  await assert.rejects(fixture.stream.finish(), /incomplete 16-bit sample/);
  assert.deepEqual(fixture.socket.sent, [Uint8Array.of(1, 2)]);
  assert.equal(fixture.errors.length, 1);
});

test("consumer failures fail the stream once without unhandled callback errors", async (context) => {
  const fixture = setup(context);
  fixture.stream.cancel();
  const error = new Error("Editor failed");
  let reports = 0;
  const stream = fixture.start(fixture.config, fixture.source.signal, () => { throw error; }, (failure) => {
    assert.equal(failure, error);
    reports++;
    throw new Error("Status failed too");
  });
  context.after(() => stream.cancel());
  await settle();
  fixture.socket.open();
  fixture.socket.message(results("Text", false));
  await assert.rejects(stream.finish(), (failure) => failure === error);
  await settle();
  assert.equal(reports, 1);
});

test("invalid audio and timeout limits fail synchronously before transport use", (context) => {
  const fixture = setup(context);
  fixture.stream.cancel();
  for (const maxSeconds of [0, -1, NaN, Infinity, 301]) {
    assert.throws(() => fixture.start({ ...fixture.config, maxSeconds }, fixture.source.signal, () => {}, () => {}), /maxSeconds/);
  }
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => fixture.start({ ...fixture.config, timeoutMs }, fixture.source.signal, () => {}, () => {}), /timeoutMs/);
  }
  assert.deepEqual(fixture.connections, []);
});

test("a retained odd byte also counts against the pending PCM budget", async (context) => {
  const fixture = setup(context);
  fixture.stream.pushAudio(Buffer.alloc(160_001));
  await assert.rejects(fixture.stream.finish(), /backpressure.*5-second pending buffer limit/);
  assert.deepEqual(fixture.connections, []);
  assert.equal(fixture.errors.length, 1);
});
