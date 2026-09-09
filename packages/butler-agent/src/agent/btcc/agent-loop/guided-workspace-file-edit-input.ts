import type { EffectAdapterError } from "../effects/index.ts";
import { normalizeWorkspaceContainedPath } from "./guided-workspace-file-target.ts";
import {
  GUIDED_EDIT_BATCH_MAX,
  GUIDED_EDIT_BATCH_MIN,
  type DecodedGuidedWorkspaceFileEditEntry,
} from "./guided-workspace-file-edit-batch.ts";

type DecodedEditInput = {
  kind: "single";
  path: string;
  startLine?: number;
  oldText: string;
  newText: string;
};

type DecodedBatchEditInput = {
  kind: "batch";
  edits: DecodedGuidedWorkspaceFileEditEntry[];
};

export type DecodedGuidedWorkspaceFileEditInput =
  | DecodedEditInput
  | DecodedBatchEditInput;

export function decodeGuidedWorkspaceFileEditInput(
  input: unknown,
  workspacePath: string,
):
  | { ok: true; value: DecodedGuidedWorkspaceFileEditInput }
  | { ok: false; error: EffectAdapterError } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return rejected(
      "edit_file_invalid_input",
      "edit_file input must be an object.",
    );
  const record = input as Record<string, unknown>;
  const singleFields = [
    "path",
    "start_line",
    "old_text",
    "new_text",
    "expected_sha256",
  ];
  const hasBatch = record.edits !== undefined;
  const hasSingle = singleFields.some((field) => record[field] !== undefined);
  if (hasBatch && hasSingle)
    return rejected(
      "edit_file_mixed_input",
      "edit_file accepts either one single edit or a canonical edits batch, never both.",
    );
  if (hasBatch) return decodeBatchEditInput(record.edits, workspacePath);
  if (!hasSingle)
    return rejected(
      "edit_file_invalid_input",
      "edit_file requires one single edit or a 2-20 entry edits batch.",
    );
  const unknown = Object.keys(record).filter(
    (key) =>
      !new Set([
        "path",
        "start_line",
        "old_text",
        "new_text",
        "expected_sha256",
      ]).has(key),
  );
  if (unknown.length > 0)
    return rejected(
      "edit_file_invalid_input",
      `edit_file rejects unknown field ${unknown[0]}.`,
    );
  if (typeof record.old_text !== "string" || record.old_text.length === 0)
    return rejected(
      "edit_file_invalid_old_text",
      "edit_file requires non-empty old_text copied from the current file.",
    );
  if (typeof record.new_text !== "string")
    return rejected(
      "edit_file_invalid_new_text",
      "edit_file requires string new_text.",
    );
  if (
    record.start_line !== undefined &&
    (!Number.isSafeInteger(record.start_line) || Number(record.start_line) < 1)
  )
    return rejected(
      "edit_file_invalid_start_line",
      "edit_file start_line must be a positive integer.",
    );
  try {
    return {
      ok: true,
      value: {
        kind: "single",
        path: normalizeWorkspaceContainedPath(
          workspacePath,
          requiredText(record.path, "path"),
        ),
        ...(record.start_line === undefined
          ? {}
          : { startLine: Number(record.start_line) }),
        oldText: record.old_text,
        newText: record.new_text,
      },
    };
  } catch {
    return rejected(
      "edit_file_invalid_path",
      "edit_file path must identify one file inside the admitted workspace.",
    );
  }
}

function decodeBatchEditInput(
  input: unknown,
  workspacePath: string,
):
  | { ok: true; value: DecodedBatchEditInput }
  | { ok: false; error: EffectAdapterError } {
  if (
    !Array.isArray(input) ||
    input.length < GUIDED_EDIT_BATCH_MIN ||
    input.length > GUIDED_EDIT_BATCH_MAX
  )
    return rejected(
      "edit_file_invalid_batch",
      `edit_file edits must contain ${GUIDED_EDIT_BATCH_MIN}-${GUIDED_EDIT_BATCH_MAX} entries.`,
    );
  const edits: DecodedGuidedWorkspaceFileEditEntry[] = [];
  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return rejected(
        "edit_file_invalid_batch",
        `edit_file edits[${index}] must be an object.`,
      );
    const entry = value as Record<string, unknown>;
    const unknown = Object.keys(entry).filter(
      (key) =>
        !new Set(["path", "start_line", "old_text", "new_text"]).has(key),
    );
    if (unknown.length > 0)
      return rejected(
        "edit_file_invalid_batch",
        `edit_file edits[${index}] rejects unknown field ${unknown[0]}.`,
      );
    if (typeof entry.old_text !== "string" || entry.old_text.length === 0)
      return rejected(
        "edit_file_invalid_old_text",
        `edit_file edits[${index}].old_text must be non-empty.`,
      );
    if (typeof entry.new_text !== "string")
      return rejected(
        "edit_file_invalid_new_text",
        `edit_file edits[${index}].new_text must be a string.`,
      );
    if (
      entry.start_line !== undefined &&
      (!Number.isSafeInteger(entry.start_line) || Number(entry.start_line) < 1)
    )
      return rejected(
        "edit_file_invalid_start_line",
        `edit_file edits[${index}].start_line must be positive.`,
      );
    try {
      const path = normalizeWorkspaceContainedPath(
        workspacePath,
        requiredText(entry.path, `edits[${index}].path`),
      );
      edits.push({
        path,
        ...(entry.start_line === undefined
          ? {}
          : { startLine: Number(entry.start_line) }),
        oldText: entry.old_text,
        newText: entry.new_text,
      });
    } catch {
      return rejected(
        "edit_file_invalid_path",
        `edit_file edits[${index}].path must be inside the workspace.`,
      );
    }
  }
  return { ok: true, value: { kind: "batch", edits } };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`edit_file requires ${field}`);
  return value.trim();
}

function rejected(
  code: string,
  message: string,
): { ok: false; error: EffectAdapterError } {
  return { ok: false, error: { code, message } };
}
