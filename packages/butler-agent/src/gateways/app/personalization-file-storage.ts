import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export function readPrivateText(path: string): string {
  try {
    return readFileSync(path, "utf8").slice(0, 32_000);
  } catch {
    return "";
  }
}

export function boundedPrivateText(value: string): string {
  const normalized = value.replace(/\r\n/gu, "\n").trim();
  return normalized.length > 32_000 ? normalized.slice(0, 32_000) : normalized;
}

export function backupPrivatePersonalizationFile(
  butlerData: string,
  sourcePath: string,
  prefix: string,
  nextText: string,
): void {
  if (!existsSync(sourcePath)) return;
  const currentText = readPrivateText(sourcePath);
  if (!currentText || currentText === nextText) return;
  const backupDir = join(butlerData, "personalization", "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(backupDir, `${prefix}-${stamp}.md`);
  copyFileSync(sourcePath, backupPath);
  prunePrivatePersonalizationBackups(backupDir, prefix, 20);
}

function prunePrivatePersonalizationBackups(
  backupDir: string,
  prefix: string,
  keep: number,
): void {
  const entries = readdirSync(backupDir)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".md"))
    .map((name) => {
      const path = join(backupDir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of entries.slice(keep)) {
    unlinkSync(entry.path);
  }
}

export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}
