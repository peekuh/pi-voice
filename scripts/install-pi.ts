import { spawn } from "node:child_process";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { access, lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PI_PACKAGE_SOURCE = "git:github.com/peekuh/pi-voice";

export interface NativePiInstallOptions {
  agentDir: string;
  packageRoot: string;
  source: string;
  command?: string;
}

export interface NativePiInstallPlan {
  target: string;
  physicalTarget: string;
  source: string;
  install(): Promise<void>;
}

interface LegacyWrapper {
  contents: string;
  metadata: Stats;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}

async function readLegacyWrapper(target: string): Promise<LegacyWrapper | undefined> {
  const metadata = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return undefined;
  if (!metadata.isFile()) throw new Error(`Refusing to migrate a symlink or nonregular extension: ${target}`);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const contents = await file.readFile("utf8");
    const opened = await file.stat();
    if (!sameFile(metadata, opened) || !sameFile(opened, await lstat(target))) {
      throw new Error(`Extension changed while being inspected: ${target}`);
    }
    return { contents, metadata: opened };
  } finally {
    await file.close();
  }
}

async function verifyPackage(root: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: unknown;
    pi?: { extensions?: unknown };
  } | null;
  const extensions = manifest?.pi?.extensions;
  if (manifest?.name !== "pi-voice" || !Array.isArray(extensions)
    || !extensions.some((entry) => entry === "index.ts" || entry === "./index.ts")) {
    throw new Error(`Expected package.json with name pi-voice and pi.extensions including index.ts: ${root}`);
  }
  if (!(await stat(join(root, "index.ts"))).isFile()) {
    throw new Error(`Pi entrypoint is not a regular file: ${join(root, "index.ts")}`);
  }
}

async function verifyLegacyWrapper(target: string, wrapper: LegacyWrapper): Promise<void> {
  const match = /^\/\/ Managed by pi-voice\.\nexport \{ default \} from ("(?:[^"\\\r\n]|\\.)*");\n$/u.exec(wrapper.contents);
  let entry: unknown;
  if (match !== null) {
    try {
      entry = JSON.parse(match[1]);
    } catch {
      // Invalid string literals are not managed wrappers.
    }
  }
  if (typeof entry !== "string" || !isAbsolute(entry) || basename(entry) !== "index.ts"
    || wrapper.contents !== `// Managed by pi-voice.\nexport { default } from ${JSON.stringify(entry)};\n`) {
    throw new Error(`Refusing to migrate an unrelated extension or malformed managed wrapper: ${target}. Review it and move it aside manually before retrying.`);
  }
  try {
    await verifyPackage(dirname(entry));
  } catch (error) {
    throw new Error(`Cannot verify the legacy pi-voice checkout referenced by ${target}: ${entry}. Restore that checkout's package.json and index.ts, or review and remove the wrapper manually before retrying.`, { cause: error });
  }
}

async function physicalExtensionTarget(target: string, removingWrapper: boolean): Promise<string> {
  let directory = dirname(target);
  for (;;) {
    const parent = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (parent !== undefined) {
      if (!(await stat(directory)).isDirectory()) throw new Error(`Extension parent is not a directory: ${directory}`);
      if (removingWrapper) await access(directory, constants.W_OK | constants.X_OK);
      return join(await realpath(directory), relative(directory, target));
    }
    directory = dirname(directory);
  }
}

function installPackage(command: string, source: string, agentDir: string, packageRoot: string): Promise<void> {
  const { promise, resolve: resolveInstall, reject } = Promise.withResolvers<void>();
  const child = spawn(command, ["install", source, "--no-approve"], {
    cwd: packageRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    shell: false,
    stdio: "inherit",
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    reject(new Error(error.code === "ENOENT"
      ? `Pi executable not found: ${command}. Install Pi or make its executable available on PATH, then retry. Legacy wrapper left untouched.`
      : `Could not start native Pi installation using ${command}: ${error.message}. Legacy wrapper left untouched.`, { cause: error }));
  });
  child.once("close", (code, signal) => {
    if (code === 0) resolveInstall();
    else reject(new Error(`Native Pi installation failed (${signal === null ? `exit ${code}` : `signal ${signal}`}). Legacy wrapper left untouched; review Pi's output above before retrying.`));
  });
  return promise;
}

export async function prepareNativePiInstall(options: NativePiInstallOptions): Promise<NativePiInstallPlan> {
  const packageRoot = resolve(options.packageRoot);
  const agentDir = resolve(options.agentDir);
  if (options.source !== PI_PACKAGE_SOURCE
    && (!isAbsolute(options.source) || resolve(options.source) !== packageRoot)) {
    throw new Error(`Pi source must be ${PI_PACKAGE_SOURCE} or the absolute local package root: ${packageRoot}`);
  }
  await verifyPackage(packageRoot);
  const target = join(agentDir, "extensions", "cloud-voice.ts");
  const wrapper = await readLegacyWrapper(target);
  if (wrapper !== undefined) await verifyLegacyWrapper(target, wrapper);
  const physicalTarget = await physicalExtensionTarget(target, wrapper !== undefined);
  const source = options.source;
  const command = options.command ?? "pi";
  return {
    target,
    physicalTarget,
    source,
    async install() {
      await installPackage(command, source, agentDir, packageRoot);
      try {
        const current = await readLegacyWrapper(target);
        if (wrapper === undefined && current === undefined) return;
        if (wrapper === undefined || current === undefined || current.contents !== wrapper.contents
          || !sameFile(current.metadata, wrapper.metadata)) {
          throw new Error("Legacy wrapper changed during native installation");
        }
        await unlink(target);
      } catch (error) {
        throw new Error(`Native Pi package installed, but the legacy wrapper needs review: ${target}. It changed or could not be safely removed; no replacement wrapper was created.`, { cause: error });
      }
    },
  };
}
