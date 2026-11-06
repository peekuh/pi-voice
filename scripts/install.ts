import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../src/config.ts";
import { parseCredentials } from "../src/credentials.ts";
import type { Provider } from "../src/types.ts";
import { detectHosts, selectHost } from "./install-host.ts";
import type { Host, HostChoice } from "./install-host.ts";
import { PI_PACKAGE_SOURCE, prepareNativePiInstall } from "./install-pi.ts";
import type { NativePiInstallPlan } from "./install-pi.ts";

const usage = "Usage: npm run install:local -- [--host pi|omp|both] [--pi-source git|local] [--pi-dir /agent/root] [--omp-dir /agent/root] [--keys-file /path/to/labelled-keys.txt | --groq-key-file /path/to/key.txt]";
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!["--host", "--pi-source", "--pi-dir", "--omp-dir", "--keys-file", "--groq-key-file"].includes(flag)
    || options.has(flag) || !value || value.startsWith("--")) throw new Error(usage);
  options.set(flag, value);
}
if (options.has("--keys-file") && options.has("--groq-key-file")) throw new Error(usage);
const requested = options.get("--host");
if (requested !== undefined && requested !== "pi" && requested !== "omp" && requested !== "both") throw new Error(usage);
const piSource = options.get("--pi-source") ?? "git";
if (piSource !== "git" && piSource !== "local") throw new Error(usage);
if (requested === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  throw new Error(`Noninteractive installation requires --host pi, --host omp, or --host both.\n${usage}`);
}
const detected = await detectHosts();
let choice: HostChoice;
if (requested !== undefined) {
  choice = requested;
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    choice = await selectHost(detected, (prompt) => terminal.question(prompt), (text) => process.stdout.write(text));
  } finally {
    terminal.close();
  }
}
const hosts: Host[] = choice === "both" ? ["pi", "omp"] : [choice];
if (choice === "omp" && options.has("--pi-source")) throw new Error("--pi-source requires selecting Pi or both hosts.");
if (hosts.includes("pi") && !detected.pi) throw new Error("Pi is required for native installation. Install the Pi CLI and ensure pi is on PATH.");
const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
type Destination =
  | { host: "pi"; target: string; physicalTarget: string; native: NativePiInstallPlan }
  | { host: "omp"; target: string; physicalTarget: string; contents: string; exists: boolean };
const destinations: Destination[] = [];
for (const host of hosts) {
  const root = resolve(options.get(`--${host}-dir`) ??
    (host === "pi" ? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") : join(homedir(), ".omp", "agent")));
  if (host === "pi") {
    const native = await prepareNativePiInstall({ agentDir: root, packageRoot, source: piSource === "local" ? packageRoot : PI_PACKAGE_SOURCE });
    destinations.push({ host, target: native.target, physicalTarget: native.physicalTarget, native });
    continue;
  }
  if (!detected.omp) console.log("OMP executable not found on PATH; preparing the requested installation anyway.");
  const entry = fileURLToPath(new URL("../omp.ts", import.meta.url));
  const entryStat = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Missing OMP extension entrypoint: ${entry}`);
    throw error;
  });
  if (!entryStat.isFile()) throw new Error(`Extension entrypoint is not a file: ${entry}`);
  const target = join(root, "extensions", "cloud-voice.ts");
  const contents = `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(entry)};\n`;
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isFile() || await readFile(target, "utf8") !== contents)) {
    throw new Error(`Refusing to overwrite an unrelated extension: ${target}`);
  }
  let directory = dirname(target);
  for (;;) {
    const parent = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (parent !== undefined) {
      // Agent roots may be symlinks, but their resolved destination must be a writable directory.
      if (!(await stat(directory)).isDirectory()) throw new Error(`Extension parent is not a directory: ${directory}`);
      if (existing === undefined) await access(directory, constants.W_OK | constants.X_OK);
      break;
    }
    directory = dirname(directory);
  }
  const physicalTarget = join(await realpath(directory), relative(directory, target));
  destinations.push({ host, target, physicalTarget, contents, exists: existing !== undefined });
}
for (let index = 0; index < destinations.length; index++) {
  if (destinations.slice(0, index).some(destination => destination.physicalTarget === destinations[index].physicalTarget)) {
    throw new Error(`Pi and OMP cannot share an extension target: ${destinations[index].target}`);
  }
}
const keySource = options.get("--keys-file") ?? options.get("--groq-key-file");
const credentials = keySource === undefined ? undefined :
  parseCredentials(await readFile(resolve(keySource), "utf8"), options.has("--groq-key-file"));
if (credentials) await loadConfig();
for (const destination of destinations) {
  if (destination.host === "pi") await destination.native.install();
}
if (credentials) {
  const path = configPath();
  await loadConfig(path);
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const config = JSON.parse(raw);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const provider of Object.keys(credentials) as Provider[]) {
    const keyFile = join(directory, `${provider}.key`);
    await writeFile(keyFile, `${credentials[provider]}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    config[provider] = { ...config[provider], apiKeyFile: keyFile };
  }
  config.provider ??= credentials.deepgram ? "deepgram" : "groq";
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  console.log("Provider keys saved to private files outside the repository; source file left untouched.");
}
for (const destination of destinations) {
  if (destination.host === "pi") {
    console.log(`Pi package installed natively from ${destination.native.source}. Restart Pi or run /reload.`);
    console.log(`Manage it with pi list and pi remove ${destination.native.source}.`);
    console.log(piSource === "git"
      ? `Update it with pi update ${destination.native.source}.`
      : "Local development source: update this checkout directly; Pi loads it without copying.");
  } else {
    if (!destination.exists) {
      await mkdir(dirname(destination.target), { recursive: true });
      await writeFile(destination.target, destination.contents, { mode: 0o600, flag: "wx" });
    }
    console.log(`OMP extension installed at ${destination.target}. Restart OMP.`);
  }
}
