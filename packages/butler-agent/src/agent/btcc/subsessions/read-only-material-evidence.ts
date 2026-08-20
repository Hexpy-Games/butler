import { stableJson } from "../identity/index.ts";
import type { GuidedToolJournalRecord } from "../ports/guided-tool-journal.ts";

export function distinctMaterialReadCount(records: readonly GuidedToolJournalRecord[]): number {
  return new Set(records.flatMap((record) => {
    const identity = materialReadIdentity(record);
    return identity ? [identity] : [];
  })).size;
}

function materialReadIdentity(record: GuidedToolJournalRecord): string | null {
  if (record.status !== "completed" || !resultSucceeded(record.result)) return null;
  const result = record.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : null;
  if (!result) return null;
  const material = (() => {
    if (record.toolName === "read_file") {
      return Array.isArray(result.files) && result.files.some((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file)) return false;
        const item = file as Record<string, unknown>;
        return item.ok !== false &&
          (typeof item.content === "string" && item.content.trim().length > 0 ||
            typeof item.bytes === "number" && item.bytes > 0);
      });
    }
    if (record.toolName === "list_files") {
      return Array.isArray(result.files) && result.files.some((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file)) return false;
        return nonEmptyString((file as Record<string, unknown>).path);
      });
    }
    if (record.toolName === "grep_files") {
      return Array.isArray(result.matches) && result.matches.some((match) => {
        if (!match || typeof match !== "object" || Array.isArray(match)) return false;
        const item = match as Record<string, unknown>;
        return nonEmptyString(item.path) && nonEmptyString(item.text);
      });
    }
    if (record.toolName === "web_search") {
      return Array.isArray(result.results) && result.results.some((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        return nonEmptyString((item as Record<string, unknown>).url);
      });
    }
    if (record.toolName === "web_read") {
      return typeof result.markdown === "string" && result.markdown.trim().length > 0 ||
        Array.isArray(result.chunks) && result.chunks.some((chunk) => {
          if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return false;
          return nonEmptyString((chunk as Record<string, unknown>).text);
        });
    }
    return false;
  })();
  return material ? `${record.toolName}:${stableJson(record.arguments)}` : null;
}

function resultSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return (value as Record<string, unknown>).ok !== false;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
