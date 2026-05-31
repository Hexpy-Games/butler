import { readFileSync, writeFileSync } from "fs";

export interface HotCacheCompactionOptions {
  now?: number;
  oldestFraction?: number;
}

export interface HotCacheCompactionResult {
  filesCompacted: number;
  summariesReEmbedded: number;
}

function splitEntries(content: string): string[] {
  return content
    .split(/(?=^## \[)/m)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function headerFor(entry: string): string {
  return entry.split("\n")[0]?.trim() || "unknown-entry";
}

function summarize(entry: string): string {
  const lines = entry
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "- (empty entry)";
  return `- ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}

export function compactHotCacheFile(
  filePath: string,
  opts: HotCacheCompactionOptions = {},
): HotCacheCompactionResult {
  const content = readFileSync(filePath, "utf8");
  const entries = splitEntries(content);
  if (entries.length < 2) {
    return { filesCompacted: 0, summariesReEmbedded: 0 };
  }

  const fraction = opts.oldestFraction ?? 0.3;
  const cutoff = Math.max(1, Math.floor(entries.length * fraction));
  if (cutoff >= entries.length) {
    return { filesCompacted: 0, summariesReEmbedded: 0 };
  }

  const oldEntries = entries.slice(0, cutoff);
  const remainingEntries = entries.slice(cutoff);
  const date = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  const compressedBlock = [
    `## [compressed] ${date}`,
    "Provenance:",
    ...oldEntries.map((entry) => `- ${headerFor(entry)}`),
    "",
    "Summary:",
    ...oldEntries.map(summarize),
  ].join("\n");

  writeFileSync(
    filePath,
    [compressedBlock, ...remainingEntries].join("\n\n").trimEnd() + "\n",
    "utf8",
  );

  return { filesCompacted: 1, summariesReEmbedded: 0 };
}
