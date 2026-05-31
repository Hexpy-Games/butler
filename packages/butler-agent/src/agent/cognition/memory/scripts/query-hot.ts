import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

/** Maximum total bytes to read from hot cache files (50KB) */
export const HOT_CACHE_SIZE_LIMIT = 51_200;

export interface HotResult {
  text: string;
  score: number;
}

/**
 * Read hot cache files newest-first, stopping when total bytes read exceeds HOT_CACHE_SIZE_LIMIT.
 * Returns keyword-matched sections sorted by score (top 5).
 */
export function readHotCache(
  hotDir: string,
  keywordSet: string[],
): HotResult[] {
  if (!existsSync(hotDir)) return [];

  const files = readdirSync(hotDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  const scored: HotResult[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (totalBytes >= HOT_CACHE_SIZE_LIMIT) break;

    const content = readFileSync(join(hotDir, file), "utf8");
    totalBytes += Buffer.byteLength(content, "utf8");

    const sections = content.split(/^(?=## \[)/m).filter((s) => s.trim());
    for (const section of sections) {
      const lower = section.toLowerCase();
      const score = keywordSet.filter((kw) => lower.includes(kw)).length;
      if (score > 0) {
        scored.push({ text: section.trim().slice(0, 500), score });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}
