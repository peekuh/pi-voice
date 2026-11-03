import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const installer = fileURLToPath(new URL("../scripts/install.ts", import.meta.url));

test("installer keeps secrets private and refuses an unrelated installed extension", async () => {
  const home = await mkdtemp(join(tmpdir(), "voice-install-"));
  const env = { ...process.env, HOME: home, PI_VOICE_CONFIG: join(home, "private", "config.json") };
  const key = "gsk_INSTALL_TEST_NOT_A_REAL_CREDENTIAL";
  try {
    const source = join(home, "key.txt");
    await writeFile(source, `Groq: ${key}\n`);
    const result = await run(process.execPath, [installer, "--groq-key-file", source], { env });
    assert.equal((result.stdout + result.stderr).includes(key), false);
    const config = JSON.parse(await readFile(env.PI_VOICE_CONFIG, "utf8"));
    assert.equal(await readFile(config.groq.apiKeyFile, "utf8"), `${key}\n`);
    assert.equal((await stat(config.groq.apiKeyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(env.PI_VOICE_CONFIG)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, "private"))).mode & 0o777, 0o700);
    assert.equal(await readFile(source, "utf8"), `Groq: ${key}\n`);
    const extension = join(home, ".pi", "agent", "extensions", "cloud-voice.ts");
    assert.equal((await readFile(extension, "utf8")).includes(key), false);
    await writeFile(extension, "unrelated user extension\n");
    await assert.rejects(run(process.execPath, [installer], { env }), /Refusing to overwrite/);
    assert.equal(await readFile(extension, "utf8"), "unrelated user extension\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("invalid installer arguments cannot create files", async () => {
  const home = await mkdtemp(join(tmpdir(), "voice-install-invalid-"));
  try {
    await mkdir(join(home, "empty"));
    await assert.rejects(run(process.execPath, [installer, "--unknown"], {
      env: { ...process.env, HOME: home, PI_VOICE_CONFIG: join(home, "config.json") },
    }), /Usage:/);
    await assert.rejects(stat(join(home, ".pi")), { code: "ENOENT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a dual-provider key file installs separate private credentials and preserves provider choice", async () => {
  const home = await mkdtemp(join(tmpdir(), "voice-install-both-"));
  const path = join(home, "config", "config.json");
  const env = { ...process.env, HOME: home, PI_VOICE_CONFIG: path };
  const groq = "gsk_SYNTHETIC_TEST_ONLY";
  const deepgram = "synthetic-deepgram-test-only";
  try {
    await mkdir(join(home, "config"));
    await writeFile(path, JSON.stringify({ provider: "deepgram", language: "en" }));
    const source = join(home, "keys.txt");
    const labelled = `Groq: ${groq}\nDeepgram: ${deepgram}\n`;
    await writeFile(source, labelled);
    const result = await run(process.execPath, [installer, "--keys-file", source], { env });
    assert.equal((result.stdout + result.stderr).includes(groq), false);
    assert.equal((result.stdout + result.stderr).includes(deepgram), false);
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.provider, "deepgram");
    assert.equal(config.language, "en");
    assert.equal(await readFile(config.groq.apiKeyFile, "utf8"), `${groq}\n`);
    assert.equal(await readFile(config.deepgram.apiKeyFile, "utf8"), `${deepgram}\n`);
    assert.equal((await stat(config.groq.apiKeyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(config.deepgram.apiKeyFile)).mode & 0o777, 0o600);
    assert.equal(await readFile(source, "utf8"), labelled);
  } finally { await rm(home, { recursive: true, force: true }); }
});
