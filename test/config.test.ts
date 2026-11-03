import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, loadConfig, saveProvider } from "../src/config.ts";

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-config-"));
  const previousPath = process.env.PI_VOICE_CONFIG;
  const previousHome = process.env.HOME;
  process.env.HOME = directory;
  delete process.env.PI_VOICE_CONFIG;
  try {
    await run(directory);
  } finally {
    if (previousPath === undefined) delete process.env.PI_VOICE_CONFIG;
    else process.env.PI_VOICE_CONFIG = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
}

test("separate loads cannot mutate each other's nested configuration", async () => {
  await isolated(async (directory) => {
    assert.equal(configPath(), join(directory, ".config", "pi-voice", "config.json"));
    const config = await loadConfig();
    const originalModel = config.groq.model;
    const originalDevice = config.capture.device;
    config.groq.model = "changed";
    config.capture.device = "changed";
    assert.equal((await loadConfig()).groq.model, originalModel);
    assert.equal((await loadConfig()).capture.device, originalDevice);
  });
});

test("environment override and explicit tilde paths deep merge nested defaults", async () => {
  await isolated(async (directory) => {
    const path = join(directory, "custom.json");
    await writeFile(path, JSON.stringify({
      provider: "deepgram", language: "auto", groq: { apiKeyFile: "~/key" },
      deepgram: { model: "nova-2" }, capture: { device: "hw:1" },
    }));
    process.env.PI_VOICE_CONFIG = "~/custom.json";
    assert.equal(configPath(), path);
    const config = await loadConfig();
    assert.equal(config.provider, "deepgram");
    assert.equal(config.language, "auto");
    assert.deepEqual(config.groq, { model: "whisper-large-v3-turbo", apiKeyEnv: "GROQ_API_KEY", apiKeyFile: "~/key" });
    assert.deepEqual(config.deepgram, { model: "nova-2", apiKeyEnv: "DEEPGRAM_API_KEY" });
    assert.deepEqual(config.capture, { ffmpegPath: "ffmpeg", device: "hw:1" });
    assert.deepEqual(await loadConfig("~/custom.json"), config);
  });
});

test("strict validation rejects malformed, unknown and unsafe configuration without echoing input", async () => {
  await isolated(async (directory) => {
    const path = join(directory, "invalid.json");
    const invalid: unknown[] = [
      null, [], "secret-input", 42,
      { secret_input: "secret-input" }, { provider: "secret-input" },
      { language: "" }, { language: "en\u001b" }, { language: "English" },
      { holdMs: "600" }, { holdMs: 99 }, { holdMs: 5001 }, { holdMs: 600.5 },
      { releaseMs: 49 }, { releaseMs: 2001 },
      { maxSeconds: 0 }, { maxSeconds: 301 }, { timeoutMs: 999 }, { timeoutMs: 300001 },
      { groq: null }, { groq: [] }, { groq: { apiKey: "secret-input" } },
      { groq: { model: "" } }, { groq: { model: "model\nsecret-input" } },
      { groq: { apiKeyEnv: "!secret-input" } }, { groq: { apiKeyFile: " " } },
      { deepgram: { endpoint: "https://example.com" } },
      { capture: { device: false } }, { capture: { ffmpegPath: "ffmpeg\u0000" } },
      { capture: { extra: true } }, { capture: "default" },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ];
    for (const value of invalid) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(loadConfig(path), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid voice config/);
        assert.doesNotMatch(error.message, /secret-input|\u001b|\u0000/);
        return true;
      });
    }
    await writeFile(path, '{"secret-input":');
    await assert.rejects(loadConfig(path), /malformed JSON/);
  });
});

test("configuration accepts documented bounds and language tags", async () => {
  await isolated(async (directory) => {
    const path = join(directory, "bounds.json");
    for (const values of [
      { holdMs: 100, releaseMs: 50, maxSeconds: 1, timeoutMs: 1000 },
      { holdMs: 5000, releaseMs: 2000, maxSeconds: 300, timeoutMs: 300000 },
    ]) {
      await writeFile(path, JSON.stringify({ ...values, language: "en-US" }));
      const config = await loadConfig(path);
      for (const [key, value] of Object.entries(values)) assert.equal(Reflect.get(config, key), value);
      assert.equal(config.language, "en-US");
    }
  });
});

test("provider persistence preserves sparse configuration and replaces files privately", async () => {
  await isolated(async (directory) => {
    const path = join(directory, "config.json");
    const original = { language: "auto", holdMs: 700, groq: { apiKeyFile: "~/private-key" }, capture: { device: "hw:2" } };
    await writeFile(path, JSON.stringify(original), { mode: 0o644 });
    process.env.PI_VOICE_CONFIG = path;
    await saveProvider("deepgram");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...original, provider: "deepgram" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["config.json"]);
    assert.equal((await loadConfig()).provider, "deepgram");
  });
});

test("provider persistence creates private default directory and refuses malformed existing data", async () => {
  await isolated(async (directory) => {
    await saveProvider("deepgram");
    const path = configPath();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { provider: "deepgram" });
    assert.equal((await stat(join(directory, ".config", "pi-voice"))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, '{"unknown":true}');
    await assert.rejects(saveProvider("groq"), /unknown key/);
    assert.equal(await readFile(path, "utf8"), '{"unknown":true}');
    await writeFile(path, "not-json");
    await assert.rejects(saveProvider("groq"), /malformed JSON/);
    assert.equal(await readFile(path, "utf8"), "not-json");
  });
});

test("unreadable configuration does not silently use defaults", async () => {
  await isolated(async (directory) => {
    await assert.rejects(loadConfig(directory), /Unable to read voice config file/);
  });
});
