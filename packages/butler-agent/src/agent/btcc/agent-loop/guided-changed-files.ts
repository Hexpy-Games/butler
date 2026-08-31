import { isAbsolute } from "node:path";
import type { GuidedToolJournalRecord } from "../ports/index.ts";
import {
  aggregateChangedFileDetails,
  type ChangedFileDetail,
} from "../../tools/file-tools/shared/changed-file-detail.ts";

const MAX_CHANGED_FILES = 40;

export function collectGuidedChangedFiles(
  records: readonly GuidedToolJournalRecord[],
  inherited: readonly ChangedFileDetail[] = [],
): ChangedFileDetail[] {
  const details: ChangedFileDetail[] = [...inherited];
  const append = (value: unknown) => {
    const detail = safeChangedFileDetail(value);
    if (detail) details.push(detail);
  };
  const appendPath = (value: unknown) => {
    const path = safeChangedFilePath(value);
    if (!path) return;
    details.push({ path, additions: 0, deletions: 0, lines: [] });
  };

  for (const record of records) {
    if (record.status !== "completed") continue;
    if (record.changedFiles?.length) {
      for (const detail of record.changedFiles) append(detail);
      continue;
    }
    const result = object(record.result);
    if (!result || result.ok === false) continue;
    if (record.toolName !== "write_file" && record.toolName !== "edit_file") continue;
    if (record.toolName === "edit_file" && Array.isArray(result.changed_files)) {
      for (const detail of result.changed_files) append(detail);
    } else if (result.changed_file) {
      append(result.changed_file);
    } else if (record.toolName === "edit_file" &&
        result.effect === "workspace_file_edit_batch") {
      const edits = Array.isArray(record.arguments.edits)
        ? record.arguments.edits
        : [];
      for (const edit of edits) appendPath(object(edit)?.path);
    } else {
      // Keep path-only rows readable when replaying a pre-detail journal.
      appendPath(result.path);
    }
  }
  return aggregateChangedFileDetails(details).slice(0, MAX_CHANGED_FILES);
}

export function changedFileDetailsFromToolResult(
  value: unknown,
): ChangedFileDetail[] {
  const result = object(value);
  if (!result) return [];
  if (Array.isArray(result.changed_files)) {
    return result.changed_files.flatMap((detail) => {
      const normalized = safeChangedFileDetail(detail);
      return normalized ? [normalized] : [];
    });
  }
  const detail = safeChangedFileDetail(result.changed_file);
  return detail ? [detail] : [];
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

function safeChangedFileDetail(value: unknown): ChangedFileDetail | null {
  const item = object(value);
  if (!item) return null;
  const path = safeChangedFilePath(item.path);
  if (!path || !Array.isArray(item.lines)) return null;
  const lines = item.lines.flatMap((line) => {
    const candidate = object(line);
    if (!candidate || (candidate.type !== "added" && candidate.type !== "deleted") ||
        typeof candidate.content !== "string") return [];
    const oldLine = candidate.old_line;
    const newLine = candidate.new_line;
    if (oldLine !== undefined &&
        (typeof oldLine !== "number" || !Number.isSafeInteger(oldLine) || oldLine < 1)) return [];
    if (newLine !== undefined &&
        (typeof newLine !== "number" || !Number.isSafeInteger(newLine) || newLine < 1)) return [];
    return [{
      type: candidate.type,
      ...(oldLine === undefined ? {} : { old_line: oldLine }),
      ...(newLine === undefined ? {} : { new_line: newLine }),
      content: candidate.content,
    }] satisfies ChangedFileDetail["lines"];
  });
  const additions = lines.filter((line) => line.type === "added").length;
  const deletions = lines.filter((line) => line.type === "deleted").length;
  if (additions === 0 && deletions === 0) return null;
  return {
    path,
    additions,
    deletions,
    lines,
    ...(typeof item.before_text === "string" ? { before_text: item.before_text } : {}),
    ...(typeof item.after_text === "string" ? { after_text: item.after_text } : {}),
  };
}
