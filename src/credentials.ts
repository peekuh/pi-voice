import type { Provider } from "./types.ts";

export function parseCredentials(text: string, groqOnly = false): Partial<Record<Provider, string>> {
  const result: Partial<Record<Provider, string>> = {};
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  for (const line of lines) {
    const match = /^(?:export\s+)?(groq(?:_api_key)?|deepgram(?:_api_key)?)\s*[:=]\s*(.*)$/i.exec(line);
    const provider: Provider | undefined = match ? (match[1].toLowerCase().startsWith("groq") ? "groq" : "deepgram") : groqOnly && lines.length === 1 ? "groq" : undefined;
    if (!provider || (groqOnly && provider !== "groq")) throw new Error("Key file must use Groq: or Deepgram: labels (GROQ_API_KEY= and DEEPGRAM_API_KEY= also work).");
    let key = (match ? match[2] : line).trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    if (!/^[A-Za-z0-9._-]+$/.test(key) || (provider === "groq" && !key.startsWith("gsk_"))) {
      throw new Error(`Invalid ${provider} key format; values must be single raw credentials.`);
    }
    if (result[provider]) throw new Error(`Duplicate ${provider} credential in key file.`);
    result[provider] = key;
  }
  if (Object.keys(result).length === 0) throw new Error("No credentials found in key file.");
  return result;
}
