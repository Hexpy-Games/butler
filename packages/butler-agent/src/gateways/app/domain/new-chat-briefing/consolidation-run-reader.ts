import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConsolidationRunSummary } from "./briefing-types.ts";

export function latestConsolidationRun(
  butlerData: string,
  sourceDate?: string | null,
): ConsolidationRunSummary | null {
  const runsDir = join(butlerData, "cognition", "consolidation", "runs");
  if (!existsSync(runsDir)) return null;
  return (
    readdirSync(runsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const path = join(runsDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map(({ path }) => readJsonFile<ConsolidationRunSummary>(path))
      .find((run) => {
        if (!run || run.status !== "completed") return false;
        if (!sourceDate) return true;
        return (
          datePart(run.completed_at) === sourceDate ||
          datePart(run.started_at) === sourceDate
        );
      }) ?? null
  );
}

function datePart(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/u.test(value)) return null;
  return value.slice(0, 10);
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
