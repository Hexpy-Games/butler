import { isAbsolute } from "node:path";
import type { GuidedToolJournalRecord } from "../ports/index.ts";

const MAX_CHANGED_FILES = 40;

export function collectGuidedChangedFiles(
  records: readonly GuidedToolJournalRecord[],
  parentResultEvidence?: string,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const append = (value: unknown) => {
    const path = safeChangedFilePath(value);
    if (!path || seen.has(path) || paths.length >= MAX_CHANGED_FILES) return;
    seen.add(path);
    paths.push(path);
  };

  for (const record of records) {
    if (record.status !== "completed") continue;
    const result = object(record.result);
    if (!result || result.ok === false) continue;
    if (record.toolName === "write_file" || record.toolName === "edit_file") {
      append(result.path);
    }
    if (record.toolName === "edit_file" && result.effect === "workspace_file_edit_batch") {
      const edits = Array.isArray(record.arguments.edits)
        ? record.arguments.edits
        : [];
      for (const edit of edits) append(object(edit)?.path);
    }
  }

  for (const path of parentResultChangedFiles(parentResultEvidence)) append(path);
  return paths;
}

function parentResultChangedFiles(evidence: string | undefined): string[] {
  if (!evidence) return [];
  const line = evidence.split("\n").find((value) =>
    value.startsWith("Changed artifacts: "),
  );
  if (!line) return [];
  const value = line.slice("Changed artifacts: ".length).trim();
  return value === "none"
    ? []
    : value.split(";").map((path) => path.trim()).filter(Boolean);
}

function safeChangedFilePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    return null;
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/").slice(0, 1_024);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
