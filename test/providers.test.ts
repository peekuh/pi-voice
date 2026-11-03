import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { resolveApiKey, transcribe } from "../src/providers.ts";
import type { Provider, VoiceConfig } from "../src/types.ts";

const KEY_ENV = "PI_VOICE_TEST_PROVIDER_KEY";
const KEY = "synthetic-key-not-a-credential";

async function isolated(provider: Provider, run: (config: VoiceConfig, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-provider-"));
  const previousKey = process.env[KEY_ENV];
  const previousHome = process.env.HOME;
  process.env[KEY_ENV] = KEY;
  try {
    const config = await loadConfig(join(directory, "missing.json"));
    config.provider = provider;
    config.groq.apiKeyEnv = KEY_ENV;
    config.deepgram.apiKeyEnv = KEY_ENV;
    await run(config, directory);
  } finally {
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
}

function pendingFetch(onStart: () => void = () => undefined): typeof fetch {
  return async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    onStart();
    if (signal.aborted) throw signal.reason;
    const { promise, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    return await promise;
  };
}

test("Groq sends authenticated multipart WAV without altering audio boundaries", async () => {
  await isolated("groq", async (config) => {
    config.groq.model = "whisper-large-v3";
    let requests = 0;
    const transport: typeof fetch = async (url, init) => {
      requests++;
      assert.equal(String(url), "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${KEY}`);
      assert.equal(new Headers(init?.headers).get("content-type"), null);
      assert.ok(init?.signal instanceof AbortSignal);
      const form = init?.body;
      assert.ok(form instanceof FormData);
      assert.equal(form.get("model"), "whisper-large-v3");
      assert.equal(form.get("language"), "en");
      assert.equal(form.get("response_format"), "json");
      const file = form.get("file");
      assert.ok(file instanceof Blob);
      assert.equal(file.type, "audio/wav");
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([2, 3]));
      return Response.json({ text: "hello\nworld\t!\u001b[31m\u0000\u007f\u0085\r" });
    };
    const audio = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    assert.equal(await transcribe(audio, config, new AbortController().signal, transport), "hello\nworld\t![31m");
    assert.equal(requests, 1);
  });
});

test("Groq automatic language omits language rather than sending auto", async () => {
  await isolated("groq", async (config) => {
    config.language = "auto";
    const transport: typeof fetch = async (_url, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.has("language"), false);
      return Response.json({ text: "" });
    };
    assert.equal(await transcribe(new Uint8Array(), config, new AbortController().signal, transport), "");
  });
});

test("Deepgram cannot fall back to prerecorded HTTP or resolve a key for that path", async () => {
  await isolated("deepgram", async (config) => {
    delete process.env[KEY_ENV];
    const transport: typeof fetch = async () => assert.fail("Deepgram HTTP must not run");
    await assert.rejects(transcribe(new Uint8Array([1, 2]), config, new AbortController().signal, transport), /Deepgram requires realtime WebSocket/);
  });
});

test("malformed JSON and missing or nonstring Groq transcript fields reject safely", async () => {
  await isolated("groq", async (config) => {
    for (const value of [{}, { text: null }, { text: 123 }, [], null]) {
      const transport: typeof fetch = async () => Response.json(value);
      await assert.rejects(transcribe(new Uint8Array(), config, new AbortController().signal, transport), /malformed transcription response/);
    }
    const invalidJson: typeof fetch = async () => new Response(`not-json-${KEY}\u001b`, { status: 200 });
    await assert.rejects(transcribe(new Uint8Array(), config, new AbortController().signal, invalidJson), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid JSON/);
      assert.doesNotMatch(error.message, /synthetic-key|\u001b/);
      return true;
    });
  });
});

test("HTTP and network errors never expose response bodies, credentials or controls and never retry", async () => {
  await isolated("groq", async (config) => {
    for (const status of [401, 403, 413, 429, 500]) {
      let requests = 0;
      const transport: typeof fetch = async () => {
        requests++;
        return new Response(`private-response-${KEY}\u001b\u0000`, { status });
      };
      await assert.rejects(transcribe(new Uint8Array(), config, new AbortController().signal, transport), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, /Groq/);
        assert.doesNotMatch(error.message, /private-response|synthetic-key|[\u0000-\u001f]/);
        return true;
      });
      assert.equal(requests, 1);
    }
    const broken: typeof fetch = async () => { throw new Error(`Authorization: ${KEY}\nprivate-network-error`); };
    await assert.rejects(transcribe(new Uint8Array(), config, new AbortController().signal, broken), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /check network connectivity/);
      assert.doesNotMatch(error.message, /synthetic-key|private-network-error|[\u0000-\u001f]/);
      return true;
    });
  });
});

test("both providers resolve trimmed raw key files, expand tilde, reload and prefer environment", async () => {
  for (const provider of ["groq", "deepgram"] as const) {
    await isolated(provider, async (config, directory) => {
      delete process.env[KEY_ENV];
      process.env.HOME = directory;
      config[provider].apiKeyFile = "~/key";
      await writeFile(join(directory, "key"), "  first-raw-key\n");
      assert.equal(await resolveApiKey(config), "first-raw-key");
      await writeFile(join(directory, "key"), "second-raw-key\n");
      assert.equal(await resolveApiKey(config), "second-raw-key");
      process.env[KEY_ENV] = KEY;
      config[provider].apiKeyFile = join(directory, "does-not-exist");
      assert.equal(await resolveApiKey(config), KEY);
      process.env[KEY_ENV] = " \n";
      config[provider].apiKeyFile = join(directory, "key");
      assert.equal(await resolveApiKey(config), "second-raw-key");
    });
  }
});

test("Groq transports the shared resolver's current file key on each request", async () => {
  await isolated("groq", async (config, directory) => {
    delete process.env[KEY_ENV];
    config.groq.apiKeyFile = join(directory, "key");
    const keys: string[] = [];
    const transport: typeof fetch = async (_url, init) => {
      keys.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ text: "ok" });
    };
    await writeFile(config.groq.apiKeyFile, "first-raw-key\n");
    await transcribe(new Uint8Array(), config, new AbortController().signal, transport);
    await writeFile(config.groq.apiKeyFile, "second-raw-key\n");
    await transcribe(new Uint8Array(), config, new AbortController().signal, transport);
    assert.deepEqual(keys, ["Bearer first-raw-key", "Bearer second-raw-key"]);
  });
});

test("missing, unreadable and malformed credentials reject without echoing secrets for either provider", async () => {
  for (const provider of ["groq", "deepgram"] as const) {
    await isolated(provider, async (config, directory) => {
      delete process.env[KEY_ENV];
      await assert.rejects(resolveApiKey(config), /API key is missing/);
      config[provider].apiKeyFile = join(directory, "missing-private-path");
      await assert.rejects(resolveApiKey(config), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /key file could not be read/);
        assert.doesNotMatch(error.message, /missing-private-path/);
        return true;
      });
      config[provider].apiKeyFile = join(directory, "key");
      await writeFile(config[provider].apiKeyFile!, "secret first\nsecret second\u001b");
      await assert.rejects(resolveApiKey(config), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /single nonempty raw key/);
        assert.doesNotMatch(error.message, /secret|\u001b|\n/);
        return true;
      });
      process.env[KEY_ENV] = "injected\r\nheader";
      await assert.rejects(resolveApiKey(config), /single nonempty raw key/);
    });
  }
});

test("already-aborted signals reject without resolving credentials or calling fetch", async () => {
  await isolated("groq", async (config) => {
    delete process.env[KEY_ENV];
    const controller = new AbortController();
    const reason = new Error("cancelled before request");
    controller.abort(reason);
    let requests = 0;
    const transport: typeof fetch = async () => { requests++; return Response.json({}); };
    await assert.rejects(transcribe(new Uint8Array(), config, controller.signal, transport), (error: unknown) => error === reason);
    assert.equal(requests, 0);
  });
});

test("caller aborts propagate unchanged to Groq transport and caller", async () => {
  await isolated("groq", async (config) => {
    const controller = new AbortController();
    const reason = new Error("cancelled while uploading");
    const { promise: entered, resolve: started } = Promise.withResolvers<void>();
    const pending = transcribe(new Uint8Array(), config, controller.signal, pendingFetch(started));
    const rejection = assert.rejects(pending, (error: unknown) => error === reason);
    await entered;
    controller.abort(reason);
    await rejection;
  });
});

test("request timeout aborts transport and yields a provider-labelled TimeoutError", async () => {
  await isolated("groq", async (config) => {
    config.timeoutMs = 10;
    await assert.rejects(transcribe(new Uint8Array(), config, new AbortController().signal, pendingFetch()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /Groq transcription timed out/);
      return true;
    });
  });
});
