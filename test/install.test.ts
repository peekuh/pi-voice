import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHosts, selectHost } from "../scripts/install-host.ts";
import type { Host } from "../scripts/install-host.ts";

const run = promisify(execFile);
const installer = fileURLToPath(new URL("../scripts/install.ts", import.meta.url));
const entries = {
  pi: fileURLToPath(new URL("../index.ts", import.meta.url)),
  omp: fileURLToPath(new URL("../omp.ts", import.meta.url)),
};
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function isolatedHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "voice-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function install(home: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const selected = args[args.indexOf("--host") + 1];
  const local = (selected === "pi" || selected === "both") && !args.includes("--pi-source");
  return run(process.execPath, [installer, ...args, ...(local ? ["--pi-source", "local"] : [])], {
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_VOICE_CONFIG: join(home, "private", "config.json"), ...extraEnv },
  });
}

async function piSources(root: string): Promise<string[]> {
  const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { packages: Array<string | { source: string }> };
  return settings.packages.map(entry => resolve(root, typeof entry === "string" ? entry : entry.source));
}

function target(home: string, host: Host): string {
  return join(home, `.${host}`, "agent", "extensions", "cloud-voice.ts");
}

function managedEntry(host: Host): string {
  return `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(entries[host])};\n`;
}

test("Pi installation is native and does not change the OMP adapter or settings", async t => {
  const home = await isolatedHome(t);
  await mkdir(join(home, ".omp", "agent", "extensions"), { recursive: true });
  await writeFile(target(home, "omp"), "unrelated user extension\n");
  const settings = join(home, ".omp", "agent", "settings.json");
  await writeFile(settings, '{"unrelated":"settings"}\n');
  const result = await install(home, ["--host", "pi"]);
  assert.deepEqual(await piSources(join(home, ".pi", "agent")), [resolve(packageRoot)]);
  await assert.rejects(stat(target(home, "pi")), { code: "ENOENT" });
  assert.equal(await readFile(target(home, "omp"), "utf8"), "unrelated user extension\n");
  assert.equal(await readFile(settings, "utf8"), '{"unrelated":"settings"}\n');
  assert.match(result.stdout, /installed natively/);
  await assert.rejects(stat(join(home, "private")), { code: "ENOENT" });
});

test("OMP can still prepare its adapter without installing or requiring Pi", async t => {
  const home = await isolatedHome(t);
  const result = await install(home, ["--host", "omp"], { PATH: join(home, "no-binaries") });
  assert.equal(await readFile(target(home, "omp"), "utf8"), managedEntry("omp"));
  await assert.rejects(stat(join(home, ".pi")), { code: "ENOENT" });
  assert.match(result.stdout, /OMP executable not found/);
});

test("missing Pi fails before modifying targets or importing keys", async t => {
  const home = await isolatedHome(t);
  const source = join(home, "keys.txt");
  await writeFile(source, "Groq: gsk_SYNTHETIC_TEST_KEY\n");
  await assert.rejects(install(home, ["--host", "both", "--keys-file", source], { PATH: join(home, "no-binaries") }), /Pi is required/);
  assert.deepEqual(await readdir(home), ["keys.txt"]);
});

test("both hosts use native Pi plus the OMP adapter without duplicate registrations", async t => {
  const home = await isolatedHome(t);
  const ompSettings = join(home, ".omp", "agent", "settings.json");
  const ompKeys = join(home, ".omp", "agent", "keybindings.json");
  await mkdir(join(home, ".omp", "agent"), { recursive: true });
  await writeFile(ompSettings, '{"stt":{"enabled":true}}\n');
  await writeFile(ompKeys, '{"space":"custom"}\n');
  await install(home, ["--host", "both"]);
  const before = await stat(target(home, "omp"));
  const result = await install(home, ["--host", "both"]);
  assert.deepEqual(await piSources(join(home, ".pi", "agent")), [resolve(packageRoot)]);
  await assert.rejects(stat(target(home, "pi")), { code: "ENOENT" });
  assert.equal(await readFile(target(home, "omp"), "utf8"), managedEntry("omp"));
  assert.equal((await stat(target(home, "omp"))).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(ompSettings, "utf8"), '{"stt":{"enabled":true}}\n');
  assert.equal(await readFile(ompKeys, "utf8"), '{"space":"custom"}\n');
  assert.match(result.stdout, /Restart Pi or run \/reload/);
  assert.match(result.stdout, /Restart OMP/);
});

test("installer keeps secrets private and refuses an unrelated installed extension", async (t) => {
  const home = await isolatedHome(t);
  const path = join(home, "private", "config.json");
  const key = "gsk_INSTALL_TEST_NOT_A_REAL_CREDENTIAL";
  const source = join(home, "key.txt");
  await writeFile(source, `Groq: ${key}\n`);
  const result = await install(home, ["--groq-key-file", source, "--host", "pi"]);
  assert.equal((result.stdout + result.stderr).includes(key), false);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(await readFile(config.groq.apiKeyFile, "utf8"), `${key}\n`);
  assert.equal((await stat(config.groq.apiKeyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, "private"))).mode & 0o777, 0o700);
  assert.equal(await readFile(source, "utf8"), `Groq: ${key}\n`);
  assert.equal((await readFile(join(home, ".pi", "agent", "settings.json"), "utf8")).includes(key), false);
  await mkdir(join(home, ".pi", "agent", "extensions"), { recursive: true });
  await writeFile(target(home, "pi"), "unrelated user extension\n");
  await assert.rejects(install(home, ["--host", "pi"]));
  assert.equal(await readFile(target(home, "pi"), "utf8"), "unrelated user extension\n");
});

for (const conflict of ["pi", "omp"] as const) {
  test(`a conflicting ${conflict} target leaves both destinations and existing secrets unchanged`, async (t) => {
    const home = await isolatedHome(t);
    const other = conflict === "pi" ? "omp" : "pi";
    await mkdir(join(home, `.${conflict}`, "agent", "extensions"), { recursive: true });
    await writeFile(target(home, conflict), "unrelated user extension\n");
    await mkdir(join(home, "private"));
    const configPath = join(home, "private", "config.json");
    const keyPath = join(home, "private", "groq.key");
    const configText = JSON.stringify({ provider: "groq", groq: { apiKeyFile: keyPath } });
    await writeFile(configPath, configText, { mode: 0o640 });
    await writeFile(keyPath, "synthetic-old-key\n", { mode: 0o640 });
    const source = join(home, "keys.txt");
    await writeFile(source, "Groq: gsk_SYNTHETIC_NEW_KEY\nDeepgram: synthetic-new-key\n");
    const configBefore = await stat(configPath);
    const keyBefore = await stat(keyPath);
    await assert.rejects(install(home, ["--host", "both", "--keys-file", source]));
    assert.equal(await readFile(target(home, conflict), "utf8"), "unrelated user extension\n");
    await assert.rejects(stat(join(home, `.${other}`)), { code: "ENOENT" });
    assert.equal(await readFile(configPath, "utf8"), configText);
    assert.equal(await readFile(keyPath, "utf8"), "synthetic-old-key\n");
    assert.equal((await stat(configPath)).mode, configBefore.mode);
    assert.equal((await stat(keyPath)).mode, keyBefore.mode);
    assert.equal((await stat(configPath)).mtimeMs, configBefore.mtimeMs);
    assert.equal((await stat(keyPath)).mtimeMs, keyBefore.mtimeMs);
    await assert.rejects(stat(join(home, "private", "deepgram.key")), { code: "ENOENT" });
  });
}

test("noninteractive installation requires an explicit host before importing keys", async (t) => {
  const home = await isolatedHome(t);
  const source = join(home, "keys.txt");
  await writeFile(source, "Groq: gsk_SYNTHETIC_KEY\n");
  await assert.rejects(install(home, ["--keys-file", source]), /Noninteractive installation requires --host/);
  assert.deepEqual(await readdir(home), ["keys.txt"]);
});

test("invalid and conflicting arguments cannot create files", async (t) => {
  const home = await isolatedHome(t);
  const cases = [
    ["--unknown"], ["--host"], ["--host", "invalid"], ["--host", "pi", "extra"],
    ["--host", "pi", "--host", "omp"], ["--host", "pi", "--host", "pi"],
    ["--host", "pi", "--pi-dir"], ["--host", "omp", "--omp-dir", ""],
    ["--host", "both", "--keys-file", "one", "--groq-key-file", "two"],
    ["--host", "pi", "--keys-file", "one", "--keys-file", "two"],
    ["--host", "pi", "--pi-dir", "one", "--pi-dir", "two"],
    ["--host", "omp", "--omp-dir", "one", "--omp-dir", "two"],
    ["--host", "pi", "--pi-source", "invalid"], ["--host", "pi", "--pi-source", "git", "--pi-source", "local"],
  ];
  for (const args of cases) {
    await assert.rejects(install(home, args), /Usage:/);
    assert.deepEqual(await readdir(home), []);
  }
});

test("custom host roots are exact agent roots, not parent profile directories", async (t) => {
  const home = await isolatedHome(t);
  const piRoot = join(home, "pi profile");
  const ompRoot = join(home, "omp profile");
  await install(home, ["--omp-dir", ompRoot, "--host", "both", "--pi-dir", piRoot]);
  assert.deepEqual(await piSources(piRoot), [resolve(packageRoot)]);
  await assert.rejects(stat(join(piRoot, "extensions", "cloud-voice.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(ompRoot, "extensions", "cloud-voice.ts"), "utf8"), managedEntry("omp"));
  for (const host of ["pi", "omp"]) await assert.rejects(stat(join(home, `.${host}`)), { code: "ENOENT" });
});

test("colliding custom roots and invalid destination parents fail before writes", async (t) => {
  const home = await isolatedHome(t);
  const shared = join(home, "shared");
  await assert.rejects(install(home, ["--host", "both", "--pi-dir", shared, "--omp-dir", shared]), /cannot share an extension target/);
  assert.deepEqual(await readdir(home), []);
  const blocked = join(home, "blocked");
  await writeFile(blocked, "not a directory");
  await assert.rejects(install(home, ["--host", "both", "--omp-dir", blocked]));
  assert.deepEqual(await readdir(home), ["blocked"]);
});

test("symlinked aliases of one host root cannot partially install different adapters", async (t) => {
  const home = await isolatedHome(t);
  const root = join(home, "root");
  const alias = join(home, "alias");
  await mkdir(root);
  await symlink(root, alias);
  await assert.rejects(install(home, ["--host", "both", "--pi-dir", root, "--omp-dir", alias]), /cannot share an extension target/);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(stat(join(home, "private")), { code: "ENOENT" });
});

test("both host key imports preserve provider choice, settings and private permissions", async (t) => {
  const home = await isolatedHome(t);
  const path = join(home, "private", "config.json");
  const groq = "gsk_SYNTHETIC_TEST_ONLY";
  const deepgram = "synthetic-deepgram-test-only";
  await mkdir(join(home, "private"));
  await writeFile(path, JSON.stringify({ provider: "groq", language: "en", groq: { model: "whisper-large-v3" } }));
  // Existing loose permissions must be tightened, not merely set when creating files.
  await writeFile(join(home, "private", "groq.key"), "old synthetic key", { mode: 0o644 });
  const source = join(home, "keys.txt");
  const labelled = `Groq: ${groq}\nDeepgram: ${deepgram}\n`;
  await writeFile(source, labelled);
  const result = await install(home, ["--keys-file", source, "--host", "both"]);
  assert.equal((result.stdout + result.stderr).includes(groq), false);
  assert.equal((result.stdout + result.stderr).includes(deepgram), false);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.provider, "groq");
  assert.equal(config.language, "en");
  assert.equal(config.groq.model, "whisper-large-v3");
  assert.equal(await readFile(config.groq.apiKeyFile, "utf8"), `${groq}\n`);
  assert.equal(await readFile(config.deepgram.apiKeyFile, "utf8"), `${deepgram}\n`);
  assert.equal((await stat(config.groq.apiKeyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(config.deepgram.apiKeyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, "private"))).mode & 0o777, 0o700);
  assert.equal(await readFile(source, "utf8"), labelled);
  assert.deepEqual(await piSources(join(home, ".pi", "agent")), [resolve(packageRoot)]);
  assert.equal(await readFile(target(home, "omp"), "utf8"), managedEntry("omp"));
});

test("host detection requires executable files on the supplied PATH", async (t) => {
  const home = await isolatedHome(t);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(join(bin, "omp"), "not executable", { mode: 0o600 });
  assert.deepEqual(await detectHosts(bin), { pi: true, omp: false });
  await chmod(join(bin, "omp"), 0o700);
  assert.deepEqual(await detectHosts(bin), { pi: true, omp: true });
  assert.deepEqual(await detectHosts(join(home, "missing")), { pi: false, omp: false });
});

test("interactive selection applies detection defaults, explicit answers and invalid-answer retry", async () => {
  for (const detected of [{ pi: true, omp: true }, { pi: true, omp: false }, { pi: false, omp: true }]) {
    const selected = await selectHost(detected, async () => "", () => {});
    assert.equal(selected, detected.pi && detected.omp ? "both" : detected.pi ? "pi" : "omp");
  }
  for (const [answer, expected] of [["1", "pi"], ["2", "omp"], ["3", "both"]] as const) {
    const selected = await selectHost({ pi: false, omp: false }, async () => answer, () => {});
    assert.equal(selected, expected);
  }
  const answers = ["", "invalid", " 2 "];
  let prompts = 0;
  const selected = await selectHost({ pi: false, omp: false }, async () => {
    prompts++;
    return answers.shift()!;
  }, () => {});
  assert.equal(selected, "omp");
  assert.equal(prompts, 3);
  assert.deepEqual(answers, []);
});
