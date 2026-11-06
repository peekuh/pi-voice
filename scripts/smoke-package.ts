import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

// Python owns and reaps the real TUI process, including on the outer timeout.
const tuiProbe = String.raw`
import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

def interrupted(signum, frame):
    raise TimeoutError("Package TUI smoke interrupted")
signal.signal(signal.SIGTERM, interrupted)
master, slave = pty.openpty()
process = None
terminal = bytearray()
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 220, 0, 0))
    process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                               env=os.environ, start_new_session=True)
    os.close(slave)
    slave = None
    negotiated = False
    deadline = time.monotonic() + 35
    ready_at = None
    sent = False
    submitted_at = None
    doctor = False
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError("Pi exited before the doctor command completed")
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise AssertionError("Pi closed its PTY before the doctor command completed") from error
                raise
            if not data:
                raise AssertionError("Pi closed its PTY")
            terminal.extend(data)
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if not negotiated and b"\x1b[?u" in terminal:
                os.write(master, b"\x1b[?1u\x1b[?1;2c")
                negotiated = True
        text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", terminal.decode("utf-8", "replace"))
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        text = " ".join(text.split())
        errors = ["needs the prompt editor", "Disable another custom-editor", "Voice requires an interactive",
                  "Failed to load extension", "Error loading extension", "[Extension issues]", "Cannot find module", "ERR_MODULE_NOT_FOUND",
                  "Duplicate command", "duplicate command", "duplicate editor", "pi-voice:", "SMOKE_NETWORK_ATTEMPT"]
        for error in errors:
            if error in text:
                raise AssertionError("Pi package load error: " + error)
        if "gpt-4o-mini" in text and ready_at is None:
            ready_at = time.monotonic()
        if ready_at is not None and not sent and time.monotonic() - ready_at > 0.5:
            # Paste bypasses hold-Space handling; the only input is a local slash command.
            os.write(master, b"\x1b[200~/voice doctor\x1b[201~")
            sent = True
            submitted_at = time.monotonic()
        if submitted_at is not None and time.monotonic() - submitted_at > 0.15:
            os.write(master, b"\r")
            submitted_at = None
        doctor = all(fragment in text for fragment in ["deepgram/nova-3", "realtime WebSocket with interim results",
                                                       "no environment key", "repeat-cadence hold detection", "recorder ffmpeg"])
        if doctor:
            # Drain another render, so a late import or duplicate-editor failure is not hidden.
            if deadline - time.monotonic() > 1:
                deadline = time.monotonic() + 0.5
    if not doctor:
        raise AssertionError("Timed out waiting for real /voice doctor provider output")
    print(json.dumps({"doctor": "deepgram/nova-3", "transport": "realtime WebSocket with interim results",
                      "credential": "no environment key", "extensionErrors": False}))
except BaseException:
    sys.stderr.write(terminal.decode("utf-8", "replace")[-18000:])
    raise
finally:
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=3)
    if slave is not None:
        os.close(slave)
    os.close(master)
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else {
      assert.ok(entry.isFile(), `Unexpected non-file in artifact: ${path}`);
      files.push(path);
    }
  }
  return files;
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

const temporary = await mkdtemp(join(tmpdir(), "pi-voice-package-"));
try {
  let cli: string;
  try {
    cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    await access(cli);
  } catch (cause) {
    throw new Error("Missing prerequisite: install the repository's development Pi dependency (npm ci).", { cause });
  }
  const home = join(temporary, "home");
  const agent = join(temporary, "agent");
  const bin = join(temporary, "bin");
  const work = join(temporary, "work");
  const artifacts = join(temporary, "artifacts");
  const unpacked = join(temporary, "unpacked");
  for (const directory of [home, agent, bin, work, artifacts, unpacked]) await mkdir(directory, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    TMPDIR: temporary,
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    PI_CODING_AGENT_DIR: agent,
    PI_VOICE_CONFIG: join(home, ".config", "pi-voice", "config.json"),
    PI_OFFLINE: "1",
    NPM_CONFIG_CACHE: join(home, ".npm"),
    NPM_CONFIG_USERCONFIG: join(home, "empty.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(home, "empty-global.npmrc"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
  };
  for (const name of ["empty.npmrc", "empty-global.npmrc"]) await writeFile(join(home, name), "");
  function run(command: string, args: string[], cwd = work, timeout = 45_000): string {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`${basename(command)} ${args.join(" ")} failed: ${result.error?.message ?? `status ${result.status}, signal ${result.signal}`}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
    return result.stdout;
  }
  try {
    run("python3", ["-c", "import fcntl, pty, termios"]);
  } catch (cause) {
    throw new Error("Missing prerequisite: python3 with POSIX standard-library PTY support is required for the real Pi TUI smoke.", { cause });
  }
  await writeFile(join(bin, "pi"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o700 });

  const packResult: unknown = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts, "--json"], packageRoot, 120_000));
  assert.ok(typeof packResult === "object" && packResult !== null, "npm pack returned invalid artifact metadata");
  const packEntries: unknown[] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  assert.equal(packEntries.length, 1, "npm pack must produce exactly one artifact");
  const packedInfo = packEntries[0];
  assert.ok(typeof packedInfo === "object" && packedInfo !== null && "filename" in packedInfo);
  const filename: unknown = packedInfo.filename;
  assert.equal(typeof filename, "string");
  assert.equal(basename(filename as string), filename, "npm pack returned an unexpected artifact path");
  const archive = join(artifacts, filename as string);
  const members = run("tar", ["-tzf", archive]).trim().split("\n");
  assert.ok(members.length > 0);
  for (const member of members) {
    assert.ok(member.startsWith("package/") && !member.split("/").includes(".."), `Unsafe archive member: ${member}`);
  }
  run("tar", ["-xzf", archive, "-C", unpacked]);
  const packed = join(unpacked, "package");
  const shipped = await filesUnder(packed);
  const required = ["package.json", "index.ts", "omp.ts", "scripts/install.ts", "scripts/install-host.ts", "scripts/install-pi.ts", "README.md", "LICENSE", "CHANGELOG.md"];
  for (const source of await filesUnder(join(packageRoot, "src"))) {
    if (source.endsWith(".ts")) required.push(`src/${source}`);
  }
  for (const file of required) assert.ok(shipped.includes(file), `Artifact is missing ${file}`);
  for (const file of shipped) {
    assert.ok(required.includes(file) || file === "scripts/smoke-package.ts", `Unexpected artifact file (possible secret/dev artifact): ${file}`);
  }
  console.log(`PASS artifact: ${basename(archive)} contains all ${required.length} runtime/installer/documentation files, no unlisted files.`);

  const unrelated = join(temporary, "unrelated-package");
  await mkdir(unrelated);
  const unrelatedManifest = JSON.stringify({ name: "pi-voice-smoke-unrelated", private: true, pi: { extensions: [] } });
  await writeFile(join(unrelated, "package.json"), unrelatedManifest);
  const unrelatedPackage = { source: unrelated, extensions: [], skills: [], prompts: [] };
  const original = { packages: [unrelatedPackage], theme: "dark", quietStartup: true, smokeUnrelated: { preserve: "unchanged" } };
  const settings = join(agent, "settings.json");
  await writeFile(settings, `${JSON.stringify(original, null, 2)}\n`);
  await mkdir(join(agent, "extensions"));
  const unrelatedExtension = join(agent, "extensions", "unrelated.ts");
  const unrelatedExtensionText = "export default function unrelated() {}\n";
  await writeFile(unrelatedExtension, unrelatedExtensionText);
  const defaultAgent = join(home, ".pi", "agent");
  await mkdir(defaultAgent, { recursive: true });
  const defaultSettings = join(defaultAgent, "settings.json");
  const defaultText = '{"smokeDefaultProfile":"must not be modified"}\n';
  await writeFile(defaultSettings, defaultText);
  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settings, "utf8"));
  }
  async function assertUnrelated(): Promise<void> {
    const current = await readSettings();
    for (const [key, value] of Object.entries(original)) {
      if (key !== "packages") assert.deepEqual(current[key], value, `Unrelated setting changed: ${key}`);
    }
    assert.equal(await readFile(unrelatedExtension, "utf8"), unrelatedExtensionText);
    assert.equal(await readFile(join(unrelated, "package.json"), "utf8"), unrelatedManifest);
    assert.equal(await readFile(defaultSettings, "utf8"), defaultText, "The default profile was modified despite PI_CODING_AGENT_DIR");
  }
  const registeredSource = relative(agent, packed);
  run(process.execPath, [cli, "install", packed]);
  assert.deepEqual(await readSettings(), { ...original, packages: [unrelatedPackage, registeredSource] });
  const filtered = { source: registeredSource, extensions: ["index.ts"], skills: [], prompts: [] };
  await writeFile(settings, `${JSON.stringify({ ...original, packages: [unrelatedPackage, filtered] }, null, 2)}\n`);
  run(process.execPath, [cli, "install", packed]);
  assert.deepEqual(await readSettings(), { ...original, packages: [unrelatedPackage, filtered] }, "Repeated native install must preserve one registration and its resource filters");
  await assertUnrelated();
  run(process.execPath, [cli, "remove", packed]);
  assert.deepEqual(await readSettings(), original, "Native remove must remove only this source");
  await access(join(packed, "index.ts"));
  await assertUnrelated();
  console.log("PASS native manager: two local installs register once, retain resource filters/unrelated data, and remove only this source.");

  const wrapper = join(agent, "extensions", "cloud-voice.ts");
  await writeFile(wrapper, `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(join(packed, "index.ts"))};\n`);
  run(process.execPath, [join(packed, "scripts", "install.ts"), "--host", "pi", "--pi-source", "local", "--pi-dir", agent]);
  assert.deepEqual(await readSettings(), { ...original, packages: [unrelatedPackage, registeredSource] });
  assert.ok(await missing(wrapper), "Packed installer left the legacy managed Pi wrapper");
  assert.ok(await missing(join(defaultAgent, "extensions", "cloud-voice.ts")), "Packed installer wrote a default-profile wrapper");
  assert.ok(await missing(environment.PI_VOICE_CONFIG!), "Installer without keys unexpectedly wrote voice configuration");
  assert.ok(await missing(join(home, ".omp")), "Pi-only installation unexpectedly created an OMP profile");
  await assertUnrelated();
  console.log("PASS packed installer: real local native registration replaces only the managed legacy wrapper; no key/config/OMP writes.");

  // Guard against accidental network use even if a future startup or slash-command regression ignores --offline.
  const networkGuard = join(temporary, "deny-network.cjs");
  await writeFile(networkGuard, `const deny = () => { throw new Error("SMOKE_NETWORK_ATTEMPT: no network is permitted in the package smoke"); };\nrequire("node:net").Socket.prototype.connect = deny;\nglobalThis.fetch = deny;\nglobalThis.WebSocket = class { constructor() { deny(); } };\n`);
  const doctor = JSON.parse(run("python3", ["-c", tuiProbe, process.execPath, "--require", networkGuard, cli,
    "--offline", "--no-session", "--no-mcp", "--no-tools", "--no-skills", "--no-prompt-templates", "--no-approve", "--verbose",
    "--provider", "openai", "--model", "gpt-4o-mini", "--api-key", "pi-voice-smoke-synthetic-unused-not-a-real-api-key"], work, 50_000));
  assert.equal(doctor.doctor, "deepgram/nova-3");
  assert.equal(doctor.extensionErrors, false);
  await assertUnrelated();
  run(process.execPath, [cli, "remove", packed]);
  assert.deepEqual((await readSettings()).packages, [unrelatedPackage]);
  await assertUnrelated();
  console.log("PASS real Pi TUI: /voice doctor loaded packed deepgram/nova-3 provider/transport/credential diagnostics, without import/editor conflicts or network access.");
  console.log("PASS distribution smoke complete; no microphone, speech API, chat request, or real user profile was used.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
