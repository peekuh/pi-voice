import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PACKAGE_SOURCE, prepareNativePiInstall } from "../scripts/install-pi.ts";

const nativeCli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));

interface Fixture {
  root: string;
  packageRoot: string;
  agentDir: string;
  target: string;
  settings: string;
  home: string;
}

async function packageAt(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "pi-voice",
    version: "0.0.0",
    private: true,
    type: "module",
    pi: { extensions: ["./index.ts"] },
  }));
  await writeFile(join(root, "index.ts"), "export default function fixture() {}\n");
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "voice native migration "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "source checkout");
  const agentDir = join(root, "exact agent root");
  const home = join(root, "isolated home");
  await packageAt(packageRoot);
  await mkdir(home);
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const settings = join(agentDir, "settings.json");
  await writeFile(settings, '{"customFixture":{"keep":true},"theme":"fixture-theme"}\n');
  await writeFile(join(agentDir, "extensions", "unrelated.ts"), "export default function unrelated() {}\n");
  return { root, packageRoot, agentDir, target: join(agentDir, "extensions", "cloud-voice.ts"), settings, home };
}

function managed(root: string): string {
  return `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(join(root, "index.ts"))};\n`;
}

async function executable(f: Fixture, body: string, name = "fixture pi.cjs"): Promise<string> {
  const command = join(f.root, name);
  await writeFile(command, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return command;
}

async function nativeCommand(f: Fixture, before = ""): Promise<string> {
  return executable(f, `${before}
const result = require("node:child_process").spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(nativeCli)}, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: ${JSON.stringify(f.home)} },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);`);
}

function options(f: Fixture, command?: string) {
  return { agentDir: f.agentDir, packageRoot: f.packageRoot, source: f.packageRoot, command };
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function settings(f: Fixture): Promise<{ customFixture: { keep: boolean }; theme: string; packages: unknown[] }> {
  return JSON.parse(await readFile(f.settings, "utf8"));
}

test("native local installation migrates the same verified checkout with roots containing spaces", async (t) => {
  const f = await fixture(t);
  await writeFile(f.target, managed(f.packageRoot));
  const command = await nativeCommand(f, `if (!require("node:fs").existsSync(${JSON.stringify(f.target)})) throw new Error("Legacy wrapper was removed before native installation completed");`);
  const beforeSettings = await readFile(f.settings, "utf8");
  const plan = await prepareNativePiInstall(options(f, command));
  assert.equal(await readFile(f.settings, "utf8"), beforeSettings);
  assert.equal(await readFile(f.target, "utf8"), managed(f.packageRoot));
  await plan.install();
  await assertMissing(f.target);
  const configured = await settings(f);
  assert.deepEqual(configured.packages, [relative(f.agentDir, f.packageRoot)]);
  assert.deepEqual(configured.customFixture, { keep: true });
  assert.equal(configured.theme, "fixture-theme");
  assert.equal(await readFile(join(f.agentDir, "extensions", "unrelated.ts"), "utf8"), "export default function unrelated() {}\n");
  assert.deepEqual(await readdir(f.home), []);
});

test("migration accepts a different old checkout only after verifying its package identity", async (t) => {
  const f = await fixture(t);
  const old = join(f.root, "old checkout");
  await packageAt(old);
  await writeFile(f.target, managed(old));
  const plan = await prepareNativePiInstall(options(f, await nativeCommand(f)));
  await plan.install();
  await assertMissing(f.target);
  assert.deepEqual((await settings(f)).packages, [relative(f.agentDir, f.packageRoot)]);
  assert.equal(await readFile(join(old, "index.ts"), "utf8"), "export default function fixture() {}\n");
});

test("repeat native installs never recreate the wrapper and preserve native resource filters", async (t) => {
  const f = await fixture(t);
  const command = await nativeCommand(f);
  await (await prepareNativePiInstall(options(f, command))).install();
  const configured = await settings(f);
  const filtered = { source: relative(f.agentDir, f.packageRoot), extensions: [], skills: [] };
  configured.packages = [filtered];
  await writeFile(f.settings, JSON.stringify(configured));
  await (await prepareNativePiInstall(options(f, command))).install();
  assert.deepEqual((await settings(f)).packages, [filtered]);
  await assertMissing(f.target);
  assert.deepEqual(await readdir(join(f.agentDir, "extensions")), ["unrelated.ts"]);
});

test("native failure leaves the legacy wrapper and unrelated settings byte-for-byte unchanged", async (t) => {
  const f = await fixture(t);
  await writeFile(f.target, managed(f.packageRoot));
  const beforeSettings = await readFile(f.settings, "utf8");
  const command = await executable(f, "process.stderr.write('synthetic native failure\\n'); process.exit(23);");
  const plan = await prepareNativePiInstall(options(f, command));
  await assert.rejects(plan.install(), /Native Pi installation failed \(exit 23\).*Legacy wrapper left untouched/);
  assert.equal(await readFile(f.target, "utf8"), managed(f.packageRoot));
  assert.equal(await readFile(f.settings, "utf8"), beforeSettings);
  assert.deepEqual(await readdir(join(f.agentDir, "extensions")), ["cloud-voice.ts", "unrelated.ts"]);
});

test("a missing Pi executable gives an actionable error without removing the wrapper", async (t) => {
  const f = await fixture(t);
  await writeFile(f.target, managed(f.packageRoot));
  const before = await readFile(f.settings, "utf8");
  const plan = await prepareNativePiInstall(options(f, join(f.root, "missing pi")));
  await assert.rejects(plan.install(), /Pi executable not found:.*Install Pi/);
  assert.equal(await readFile(f.target, "utf8"), managed(f.packageRoot));
  assert.equal(await readFile(f.settings, "utf8"), before);
});

for (const change of ["contents", "replacement", "symlink", "new wrapper"] as const) {
  test(`successful native install retains an externally changed ${change} for review`, async (t) => {
    const f = await fixture(t);
    if (change !== "new wrapper") await writeFile(f.target, managed(f.packageRoot));
    const edited = "// externally edited extension\n";
    const replacement = join(f.root, "external replacement.ts");
    await writeFile(replacement, change === "replacement" ? managed(f.packageRoot) : edited);
    const target = JSON.stringify(f.target);
    const mutation = change === "replacement"
      ? `require("node:fs").renameSync(${JSON.stringify(replacement)}, ${target});`
      : change === "symlink"
        ? `require("node:fs").unlinkSync(${target}); require("node:fs").symlinkSync(${JSON.stringify(replacement)}, ${target});`
        : `require("node:fs").writeFileSync(${target}, ${JSON.stringify(edited)});`;
    const plan = await prepareNativePiInstall(options(f, await nativeCommand(f, mutation)));
    await assert.rejects(plan.install(), /Native Pi package installed, but the legacy wrapper needs review/);
    assert.deepEqual((await settings(f)).packages, [relative(f.agentDir, f.packageRoot)]);
    assert.equal(await readFile(f.target, "utf8"), change === "replacement" ? managed(f.packageRoot) : edited);
    if (change === "symlink") assert.equal((await lstat(f.target)).isSymbolicLink(), true);
  });
}

for (const kind of ["unrelated", "marker only", "extra code", "relative", "other entry", "missing checkout", "wrong name", "missing manifest entry", "missing old entry", "invalid manifest", "symlink", "directory"] as const) {
  test(`preflight refuses ${kind} without changing settings or the extension`, async (t) => {
    const f = await fixture(t);
    const old = join(f.root, "untrusted checkout");
    await packageAt(old);
    if (kind === "wrong name") await writeFile(join(old, "package.json"), '{"name":"other","pi":{"extensions":["index.ts"]}}');
    if (kind === "missing manifest entry") await writeFile(join(old, "package.json"), '{"name":"pi-voice","pi":{"extensions":["omp.ts"]}}');
    if (kind === "invalid manifest") await writeFile(join(old, "package.json"), "not json");
    if (kind === "missing old entry") await rm(join(old, "index.ts"));
    let contents = managed(old);
    if (kind === "unrelated") contents = "export default function unrelated() {}\n";
    if (kind === "marker only") contents = "// Managed by pi-voice.\nexport default function unrelated() {}\n";
    if (kind === "extra code") contents += "console.log('unrelated code');\n";
    if (kind === "relative") contents = '// Managed by pi-voice.\nexport { default } from "../index.ts";\n';
    if (kind === "other entry") contents = `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(join(old, "omp.ts"))};\n`;
    if (kind === "missing checkout") contents = managed(join(f.root, "does not exist"));
    if (kind === "symlink") await symlink(join(old, "index.ts"), f.target);
    else if (kind === "directory") await mkdir(f.target);
    else await writeFile(f.target, contents);
    const before = await lstat(f.target);
    const beforeSettings = await readFile(f.settings, "utf8");
    await assert.rejects(prepareNativePiInstall(options(f)), /Refusing to migrate|Cannot verify the legacy/);
    assert.equal(await readFile(f.settings, "utf8"), beforeSettings);
    assert.equal((await lstat(f.target)).ino, before.ino);
    if (before.isFile()) assert.equal(await readFile(f.target, "utf8"), contents);
  });
}

test("preflight rejects arbitrary npm, Git, and mismatched local sources", async (t) => {
  const f = await fixture(t);
  for (const source of ["pi-voice", "npm:pi-voice", "git:github.com/other/pi-voice", "./source checkout", join(f.root, "other package")]) {
    await assert.rejects(prepareNativePiInstall({ ...options(f), source }), /Pi source must be/);
  }
  const plan = await prepareNativePiInstall({ ...options(f), source: PI_PACKAGE_SOURCE });
  assert.equal(plan.source, PI_PACKAGE_SOURCE);
  await assertMissing(f.target);
});

test("preflight validates the selected package's Pi manifest and entrypoint", async (t) => {
  const f = await fixture(t);
  await rm(join(f.packageRoot, "index.ts"));
  await assert.rejects(prepareNativePiInstall(options(f)), { code: "ENOENT" });
  await packageAt(f.packageRoot);
  await writeFile(join(f.packageRoot, "package.json"), '{"name":"pi-voice","pi":{"extensions":["omp.ts"]}}');
  await assert.rejects(prepareNativePiInstall(options(f)), /pi.extensions including index.ts/);
  await assertMissing(f.target);
});

test("physical targets resolve root aliases and missing descendants without creating directories", async (t) => {
  const f = await fixture(t);
  const shared = join(f.root, "physical profile");
  const alias = join(f.root, "profile alias");
  await mkdir(shared);
  await symlink(shared, alias);
  const real = await prepareNativePiInstall({ ...options(f), agentDir: join(shared, "new agent") });
  const linked = await prepareNativePiInstall({ ...options(f), agentDir: join(alias, "new agent") });
  assert.equal(real.physicalTarget, linked.physicalTarget);
  assert.equal(real.physicalTarget, join(await realpath(shared), "new agent", "extensions", "cloud-voice.ts"));
  assert.deepEqual(await readdir(shared), []);
});

test("preflight rejects a non-directory destination ancestor", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.root, "blocked");
  await writeFile(blocked, "not a directory");
  await assert.rejects(prepareNativePiInstall({ ...options(f), agentDir: blocked }), /ENOTDIR|not a directory/);
  assert.equal(await readFile(blocked, "utf8"), "not a directory");
});

test("preflight requires a writable parent even when the legacy wrapper already exists", { skip: process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.target, managed(f.packageRoot));
  await chmod(dirname(f.target), 0o500);
  try {
    await assert.rejects(prepareNativePiInstall(options(f)), { code: "EACCES" });
    assert.equal(await readFile(f.target, "utf8"), managed(f.packageRoot));
  } finally {
    await chmod(dirname(f.target), 0o700);
  }
});

test("fresh native installation does not require write access to an unused extensions directory", async t => {
  const f = await fixture(t);
  await chmod(dirname(f.target), 0o500);
  try {
    await (await prepareNativePiInstall(options(f, await nativeCommand(f)))).install();
    assert.deepEqual((await settings(f)).packages, [relative(f.agentDir, f.packageRoot)]);
    await assertMissing(f.target);
    assert.deepEqual(await readdir(dirname(f.target)), ["unrelated.ts"]);
  } finally {
    await chmod(dirname(f.target), 0o700);
  }
});
