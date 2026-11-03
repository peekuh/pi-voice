import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { createStartTranscriptionStream, startTranscriptionStream } from "../src/stream.ts";
import type { TranscriptUpdate, VoiceConfig } from "../src/types.ts";

interface PendingRequest {
  audio: Uint8Array;
  signal: AbortSignal;
  at: number;
  result: PromiseWithResolvers<string>;
}

function pcm(milliseconds: number, amplitude = 0): Buffer {
  const audio = Buffer.alloc(milliseconds * 16 * 2);
  for (let sample = 0; sample < audio.byteLength / 2; sample++) {
    audio.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  return audio;
}

function phrase(amplitude = 6_000): Buffer {
  return Buffer.concat([pcm(300, amplitude), pcm(600)]);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function setup(rateLimited = false) {
  const config: VoiceConfig = {
    provider: "groq",
    language: "en",
    holdMs: 600,
    releaseMs: 150,
    maxSeconds: 30,
    timeoutMs: 30_000,
    groq: { model: "whisper-large-v3-turbo", apiKeyEnv: "UNUSED_GROQ_KEY" },
    deepgram: { model: "nova-3", apiKeyEnv: "UNUSED_DEEPGRAM_KEY" },
    capture: { ffmpegPath: "ffmpeg", device: "default" },
  };
  const requests: PendingRequest[] = [];
  const texts: string[] = [];
  const errors: Error[] = [];
  const source = new AbortController();
  let clock = 0;
  const start = createStartTranscriptionStream((audio, suppliedConfig, signal) => {
    assert.equal(suppliedConfig, config);
    const result = Promise.withResolvers<string>();
    requests.push({ audio, signal, at: Date.now(), result });
    return result.promise;
  }, () => rateLimited ? Date.now() : (clock += 3_100));
  const stream = start(config, source.signal, (update) => {
    assert.equal(update.final, true);
    texts.push(update.text);
  }, (error) => errors.push(error));
  return { config, requests, texts, errors, source, start, stream };
}

test("Groq silence is never submitted as a phrase-batch request", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(pcm(12_000));
  fixture.stream.pushAudio(pcm(3_000, 100));
  await fixture.stream.finish();
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.texts, []);
  assert.deepEqual(fixture.errors, []);
});

test("a pause starts a WAV request and commits text while capture is still open", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(phrase());
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0]!;
  const wav = Buffer.from(request.audio);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), phrase());
  request.result.resolve("First phrase.");
  await settle();
  assert.deepEqual(fixture.texts, ["First phrase."]);
  fixture.stream.pushAudio(phrase(4_000));
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1]!.result.resolve("Second phrase.");
  await fixture.stream.finish();
  assert.deepEqual(fixture.texts, ["First phrase.", "Second phrase."]);
  assert.deepEqual(fixture.errors, []);
});

test("finish flushes once, awaits the last result, and ignores later audio", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(pcm(250, 6_000));
  assert.equal(fixture.requests.length, 0);
  const finished = fixture.stream.finish();
  assert.equal(fixture.stream.finish(), finished);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]!.audio.byteLength, 8_044);
  let completed = false;
  void finished.then(() => { completed = true; });
  await settle();
  assert.equal(completed, false);
  fixture.requests[0]!.result.resolve("Tail.");
  await finished;
  assert.equal(completed, true);
  fixture.stream.pushAudio(phrase());
  assert.equal(fixture.stream.finish(), finished);
  fixture.stream.cancel();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.texts, ["Tail."]);
});

test("continuous speech creates ordered 12-second requests and a final non-overlapping tail", async () => {
  const fixture = setup();
  const audio = pcm(24_300, 6_000);
  fixture.stream.pushAudio(audio);
  assert.equal(fixture.requests.length, 1);
  const finished = fixture.stream.finish();
  fixture.requests[0]!.result.resolve("One.");
  await settle();
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1]!.result.resolve("Two.");
  await settle();
  assert.equal(fixture.requests.length, 3);
  fixture.requests[2]!.result.resolve("Three.");
  await finished;
  assert.deepEqual(fixture.requests.map((request) => request.audio.byteLength), [384_044, 384_044, 9_644]);
  assert.deepEqual(Buffer.concat(fixture.requests.map((request) => request.audio.subarray(44))), audio);
  assert.deepEqual(fixture.texts, ["One.", "Two.", "Three."]);
});

test("queued phrases are submitted serially in capture order without overlapping calls", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(Buffer.concat([phrase(6_000), phrase(5_000), phrase(4_000)]));
  const finished = fixture.stream.finish();
  assert.equal(fixture.requests.length, 1);
  for (let index = 0; index < 3; index++) {
    assert.equal(fixture.requests.length, index + 1);
    assert.deepEqual(Buffer.from(fixture.requests[index]!.audio.subarray(44)), phrase(6_000 - index * 1_000));
    fixture.requests[index]!.result.resolve(`Phrase ${index}.`);
    await settle();
  }
  await finished;
  assert.deepEqual(fixture.texts, ["Phrase 0.", "Phrase 1.", "Phrase 2."]);
});

test("Groq request starts are separated by at least 3100ms", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const fixture = setup(true);
  fixture.stream.pushAudio(Buffer.concat([phrase(), phrase(), phrase()]));
  const finished = fixture.stream.finish();
  assert.deepEqual(fixture.requests.map((request) => request.at), [0]);
  fixture.requests[0]!.result.resolve("One.");
  await settle();
  context.mock.timers.tick(3_099);
  await settle();
  assert.equal(fixture.requests.length, 1);
  context.mock.timers.tick(1);
  await settle();
  assert.deepEqual(fixture.requests.map((request) => request.at), [0, 3_100]);
  fixture.requests[1]!.result.resolve("Two.");
  await settle();
  context.mock.timers.tick(3_100);
  await settle();
  assert.deepEqual(fixture.requests.map((request) => request.at), [0, 3_100, 6_200]);
  fixture.requests[2]!.result.resolve("Three.");
  await finished;
});

test("Groq spacing is shared across recordings created by the same starter", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const fixture = setup(true);
  fixture.stream.pushAudio(phrase());
  fixture.requests[0]!.result.resolve("First recording.");
  await fixture.stream.finish();
  const second = fixture.start(fixture.config, new AbortController().signal, (update) => fixture.texts.push(update.text), (error) => fixture.errors.push(error));
  second.pushAudio(phrase());
  assert.equal(fixture.requests.length, 1);
  context.mock.timers.tick(3_100);
  await settle();
  assert.deepEqual(fixture.requests.map((request) => request.at), [0, 3_100]);
  fixture.requests[1]!.result.resolve("Second recording.");
  await second.finish();
  assert.deepEqual(fixture.texts, ["First recording.", "Second recording."]);
});

test("cancelling a Groq rate wait immediately rejects finish and never starts queued audio", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const fixture = setup(true);
  fixture.stream.pushAudio(Buffer.concat([phrase(), phrase()]));
  fixture.requests[0]!.result.resolve("Already committed.");
  await settle();
  fixture.stream.cancel();
  await assert.rejects(fixture.stream.finish(), { name: "AbortError" });
  context.mock.timers.tick(30_000);
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.texts, ["Already committed."]);
  assert.deepEqual(fixture.errors, []);
});

test("cancel aborts in-flight work, discards queued audio, and suppresses a late response", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(Buffer.concat([phrase(), phrase()]));
  const finished = fixture.stream.finish();
  fixture.stream.cancel();
  fixture.stream.cancel();
  assert.equal(fixture.requests[0]!.signal.aborted, true);
  await assert.rejects(finished, { name: "AbortError" });
  fixture.requests[0]!.result.resolve("Must not be inserted.");
  fixture.stream.pushAudio(phrase());
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.texts, []);
  assert.deepEqual(fixture.errors, []);
});

test("external abort suppresses late errors and an already-aborted signal cannot record", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(phrase());
  fixture.source.abort();
  await assert.rejects(fixture.stream.finish(), { name: "AbortError" });
  fixture.requests[0]!.result.reject(new Error("Late network failure."));
  await settle();
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.texts, []);
  const second = fixture.start(fixture.config, fixture.source.signal, () => assert.fail("late text"), () => assert.fail("late error"));
  second.pushAudio(phrase());
  await assert.rejects(second.finish(), { name: "AbortError" });
  assert.equal(fixture.requests.length, 1);
});

test("a provider failure reports once, rejects finish safely, and never retries queued speech", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(Buffer.concat([phrase(), phrase()]));
  const error = new Error("Provider rejected the request.");
  fixture.requests[0]!.result.reject(error);
  await settle();
  assert.deepEqual(fixture.errors, [error]);
  assert.equal(fixture.requests[0]!.signal.aborted, true);
  await assert.rejects(fixture.stream.finish(), (failure) => failure === error);
  fixture.stream.pushAudio(phrase());
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.texts, []);
  assert.deepEqual(fixture.errors, [error]);
});

test("maxSeconds bounds all received and queued PCM and overflow fails instead of dropping speech", async () => {
  const fixture = setup();
  fixture.config.maxSeconds = 2;
  const stream = fixture.start(fixture.config, fixture.source.signal, (update) => fixture.texts.push(update.text), (error) => fixture.errors.push(error));
  stream.pushAudio(Buffer.concat([phrase(), phrase()]));
  stream.pushAudio(pcm(250, 6_000));
  await assert.rejects(stream.finish(), /2-second transcription buffer limit/);
  assert.equal(fixture.errors.length, 1);
  assert.equal(fixture.requests[0]!.signal.aborted, true);
  fixture.requests[0]!.result.resolve("Late.");
  await settle();
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.texts, []);
});

test("silence still counts against maxSeconds without any provider requests", async () => {
  const fixture = setup();
  fixture.config.maxSeconds = 1;
  const stream = fixture.start(fixture.config, fixture.source.signal, () => assert.fail("silence text"), (error) => fixture.errors.push(error));
  stream.pushAudio(pcm(1_000));
  stream.pushAudio(Uint8Array.of(0, 0));
  await assert.rejects(stream.finish(), /transcription buffer limit/);
  assert.equal(fixture.errors.length, 1);
  assert.deepEqual(fixture.requests, []);
});

test("odd PCM tails reject finish and report once without uploading a corrupt WAV", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(pcm(300, 6_000));
  fixture.stream.pushAudio(Uint8Array.of(1));
  await assert.rejects(fixture.stream.finish(), /incomplete 16-bit sample/);
  assert.equal(fixture.errors.length, 1);
  assert.deepEqual(fixture.requests, []);
});

test("arbitrarily split byte chunks produce one intact WAV and one committed callback", async () => {
  const fixture = setup();
  const audio = phrase();
  for (let offset = 0; offset < audio.byteLength; offset += 137) {
    fixture.stream.pushAudio(audio.subarray(offset, offset + 137));
  }
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(Buffer.from(fixture.requests[0]!.audio.subarray(44)), audio);
  fixture.requests[0]!.result.resolve("Once.");
  await fixture.stream.finish();
  assert.deepEqual(fixture.texts, ["Once."]);
  assert.equal(fixture.requests.length, 1);
});

test("blank provider text is not inserted", async () => {
  const fixture = setup();
  fixture.stream.pushAudio(phrase());
  fixture.requests[0]!.result.resolve(" \n\t ");
  await fixture.stream.finish();
  assert.deepEqual(fixture.texts, []);
});

test("consumer callback errors fail the stream without escaping as unhandled rejections", async () => {
  const fixture = setup();
  const error = new Error("Editor insertion failed.");
  let reports = 0;
  const stream = fixture.start(fixture.config, fixture.source.signal, () => { throw error; }, (failure) => {
    assert.equal(failure, error);
    reports++;
    throw new Error("Status rendering failed too.");
  });
  stream.pushAudio(phrase());
  fixture.requests[0]!.result.resolve("Phrase.");
  await assert.rejects(stream.finish(), (failure) => failure === error);
  await settle();
  assert.equal(reports, 1);
});

test("invalid audio limits fail synchronously before transport use", () => {
  const fixture = setup();
  for (const maxSeconds of [0, -1, NaN, Infinity, 301]) {
    assert.throws(() => fixture.start({ ...fixture.config, maxSeconds }, fixture.source.signal, () => {}, () => {}), /maxSeconds/);
  }
  assert.deepEqual(fixture.requests, []);
});

test("the default transport rate-limits actual Groq HTTP requests without real credentials", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const fixture = setup(true);
  const keyName = `PI_VOICE_STREAM_TEST_KEY_${process.pid}`;
  assert.equal(Object.hasOwn(process.env, keyName), false);
  process.env[keyName] = "fixture-key-not-a-real-credential";
  fixture.config.groq.apiKeyEnv = keyName;
  const starts: number[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.groq.com/openai/v1/audio/transcriptions");
    starts.push(Date.now());
    return Response.json({ text: `HTTP phrase ${starts.length}.` });
  });
  const start = createStartTranscriptionStream(undefined, () => Date.now());
  const stream = start(fixture.config, fixture.source.signal, (update) => fixture.texts.push(update.text), (error) => fixture.errors.push(error));
  try {
    stream.pushAudio(Buffer.concat([phrase(), phrase()]));
    await settle();
    assert.deepEqual(starts, [0]);
    context.mock.timers.tick(3_099);
    await settle();
    assert.deepEqual(starts, [0]);
    context.mock.timers.tick(1);
    await stream.finish();
    assert.deepEqual(starts, [0, 3_100]);
    assert.deepEqual(fixture.texts, ["HTTP phrase 1.", "HTTP phrase 2."]);
    assert.deepEqual(fixture.errors, []);
  } finally {
    stream.cancel();
    delete process.env[keyName];
  }
});

test("the public Deepgram dispatcher sends continuous raw PCM and surfaces interim/final WebSocket results", async (context) => {
  const fixture = setup();
  fixture.config.provider = "deepgram";
  const keyName = `PI_VOICE_DISPATCH_TEST_KEY_${process.pid}`;
  assert.equal(Object.hasOwn(process.env, keyName), false);
  process.env[keyName] = "fixture-realtime-key-not-a-credential";
  fixture.config.deepgram.apiKeyEnv = keyName;
  context.after(() => { delete process.env[keyName]; });
  const sent: (string | Uint8Array)[] = [];
  const updates: TranscriptUpdate[] = [];
  const socket = Object.assign(new EventTarget(), {
    readyState: 0,
    bufferedAmount: 0,
    send(data: string | Uint8Array): void {
      assert.equal(this.readyState, 1);
      sent.push(typeof data === "string" ? data : data.slice());
    },
    close(): void { this.readyState = 2; },
  });
  let connections = 0;
  context.mock.method(globalThis, "WebSocket", function (url: URL, protocols: string[]) {
    connections++;
    assert.equal(url.origin, "wss://api.deepgram.com");
    assert.deepEqual(protocols, ["token", "fixture-realtime-key-not-a-credential"]);
    return socket;
  });
  context.mock.method(globalThis, "fetch", async () => assert.fail("Deepgram must never use HTTP phrase uploads"));
  const stream = startTranscriptionStream(fixture.config, fixture.source.signal, (update) => updates.push(update), (error) => fixture.errors.push(error));
  context.after(() => stream.cancel());
  const first = pcm(100, 6_000);
  stream.pushAudio(first);
  await settle();
  assert.equal(connections, 1);
  socket.readyState = 1;
  socket.dispatchEvent(new Event("open"));
  assert.deepEqual(Buffer.concat(sent as Uint8Array[]), first);
  stream.pushAudio(pcm(100, 6_000));
  assert.equal(Buffer.concat(sent as Uint8Array[]).byteLength, 6_400);
  socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({
    type: "Results", start: 0, duration: 0.2, is_final: false,
    channel: { alternatives: [{ transcript: "Still speaking" }] },
  }) }));
  assert.deepEqual(updates, [{ text: "Still speaking", final: false }]);
  const finished = stream.finish();
  assert.equal(sent.at(-1), '{"type":"CloseStream"}');
  socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({
    type: "Results", start: 0, duration: 0.2, is_final: true, speech_final: false,
    channel: { alternatives: [{ transcript: "Final on release." }] },
  }) }));
  socket.dispatchEvent(Object.assign(new Event("message"), { data: '{"type":"Metadata"}' }));
  socket.readyState = 3;
  socket.dispatchEvent(Object.assign(new Event("close"), { code: 1000, wasClean: true }));
  await finished;
  assert.deepEqual(updates, [{ text: "Still speaking", final: false }, { text: "Final on release.", final: true }]);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.errors, []);
});
