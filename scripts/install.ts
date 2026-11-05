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

const usage = "Usage: npm run install:local -- [--host pi|omp|both] [--pi-dir /agent/root] [--omp-dir /agent/root] [--keys-file /path/to/labelled-keys.txt | --groq-key-file /path/to/key.txt]";
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!["--host", "--pi-dir", "--omp-dir", "--keys-file", "--groq-key-file"].includes(flag)
    || options.has(flag) || !value || value.startsWith("--")) throw new Error(usage);
  options.set(flag, value);
}
if (options.has("--keys-file") && options.has("--groq-key-file")) throw new Error(usage);
const requested = options.get("--host");
if (requested !== undefined && requested !== "pi" && requested !== "omp" && requested !== "both") throw new Error(usage);
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
const destinations: { host: Host; target: string; physicalTarget: string; contents: string; exists: boolean }[] = [];
for (const host of hosts) {
  if (!detected[host]) console.log(`${host === "pi" ? "Pi" : "OMP"} executable not found on PATH; preparing the requested installation anyway.`);
  const entry = fileURLToPath(new URL(host === "pi" ? "../index.ts" : "../omp.ts", import.meta.url));
  const entryStat = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Missing ${host === "pi" ? "Pi" : "OMP"} extension entrypoint: ${entry}`);
    throw error;
  });
  if (!entryStat.isFile()) throw new Error(`Extension entrypoint is not a file: ${entry}`);
  const root = options.get(`--${host}-dir`);
  const target = join(root === undefined ? join(homedir(), `.${host}`, "agent") : resolve(root), "extensions", "cloud-voice.ts");
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
  if (destinations.some((destination) => destination.physicalTarget === physicalTarget)) {
    throw new Error(`Pi and OMP cannot share an extension target: ${target}`);
  }
  destinations.push({ host, target, physicalTarget, contents, exists: existing !== undefined });
}
const keySource = options.get("--keys-file") ?? options.get("--groq-key-file");
if (keySource !== undefined) {
  const credentials = parseCredentials(await readFile(resolve(keySource), "utf8"), options.has("--groq-key-file"));
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
for (const { host, target, contents, exists } of destinations) {
  if (!exists) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { mode: 0o600, flag: "wx" });
  }
  console.log(host === "pi"
    ? `Pi extension installed at ${target}. Restart Pi or run /reload.`
    : `OMP extension installed at ${target}. Restart OMP.`);
}
