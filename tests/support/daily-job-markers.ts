import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function localDay(timeZone: string | undefined, at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function markDailyJobsDone(butlerData: string, timeZone: string | undefined, at = new Date()): void {
  const directory = join(butlerData, "state/scheduler");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const marker = JSON.stringify({ lastRunDate: localDay(timeZone, at), lastRunAt: at.toISOString(), status: "ok" });
  for (const id of ["session-sync", "consolidation-cycle"]) {
    try {
      writeFileSync(join(directory, `${id}.json`), marker, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
