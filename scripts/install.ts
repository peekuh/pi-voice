import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "../src/config.ts";
import { parseCredentials } from "../src/credentials.ts";
import type { Provider } from "../src/types.ts";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || !["--groq-key-file", "--keys-file"].includes(args[0]) || args[1].startsWith("--"))) {
  throw new Error("Usage: npm run install:local -- [--keys-file /path/to/labelled-keys.txt | --groq-key-file /path/to/key.txt]");
}
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
const target = join(homedir(), ".pi", "agent", "extensions", "cloud-voice.ts");
const contents = `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(entry)};\n`;
const old = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (old !== undefined && old !== contents) throw new Error(`Refusing to overwrite an unrelated extension: ${target}`);
if (args.length > 0) {
  const credentials = parseCredentials(await readFile(resolve(args[1]), "utf8"), args[0] === "--groq-key-file");
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
await mkdir(dirname(target), { recursive: true });
await writeFile(target, contents, { mode: 0o600 });
console.log(`Pi extension installed at ${target}. Restart Pi or run /reload. OMP was not changed.`);
