import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type Host = "pi" | "omp";
export type HostChoice = Host | "both";
export interface DetectedHosts { pi: boolean; omp: boolean }

export async function detectHosts(path: string = process.env.PATH ?? ""): Promise<DetectedHosts> {
  const installed = async (host: Host): Promise<boolean> => {
    for (const directory of path.split(delimiter)) {
      const binary = join(directory || ".", host);
      try {
        await access(binary, constants.X_OK);
        if ((await stat(binary)).isFile()) return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw error;
      }
    }
    return false;
  };
  const [pi, omp] = await Promise.all([installed("pi"), installed("omp")]);
  return { pi, omp };
}

export async function selectHost(
  detected: DetectedHosts,
  question: (prompt: string) => Promise<string>,
  write: (text: string) => void,
): Promise<HostChoice> {
  const defaultChoice = detected.pi && detected.omp ? "both" : detected.pi ? "pi" : detected.omp ? "omp" : undefined;
  const choices: HostChoice[] = ["pi", "omp", "both"];
  write(`Choose where to install pi-voice:\n  1) Pi (${detected.pi ? "detected on PATH" : "not found on PATH"})\n  2) OMP (${detected.omp ? "detected on PATH" : "not found on PATH"})\n  3) Both\n`);
  const defaultNumber = defaultChoice === undefined ? undefined : choices.indexOf(defaultChoice) + 1;
  for (;;) {
    const answer = (await question(`Host [1-3]${defaultNumber === undefined ? "" : ` (default ${defaultNumber})`}: `)).trim();
    if (!answer && defaultChoice !== undefined) return defaultChoice;
    if (answer === "1" || answer === "2" || answer === "3") return choices[Number(answer) - 1];
    write("Enter 1 for Pi, 2 for OMP, or 3 for both.\n");
  }
}
