import { relative } from "node:path";
import { TextDecoder } from "node:util";
import { getWorkspaceRoot } from "../shared/args.ts";
import {
  observeWorkspaceFileMutation,
  prepareWorkspaceFileMutation,
  type PreparedWorkspaceFileMutation,
  type WorkspaceMutationSnapshot,
} from "../shared/workspace-file-mutation.ts";
import { commitWorkspaceFileMutationBatch } from "../shared/workspace-file-batch-commit.ts";
import { withButlerFileMutationLock } from "../shared/workspace-file-mutation-lock.ts";
import {
  fileToolCapabilityReceipt,
  fileToolEvidenceReceipt,
} from "../shared/evidence.ts";
import {
  resolveWorkspacePathGuard,
  safeWorkspaceGuardResult,
  safeWorkspaceResultPath,
  type WorkspacePathGuardResult,
} from "../shared/workspace-path-guard.ts";
import { normalizeWorkspaceSha256 } from "../shared/workspace-sha256.ts";
import { locateExactText } from "./exact-text-locator.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

const BATCH_MIN_EDITS = 2;
const BATCH_MAX_EDITS = 20;

export interface NormalizedEdit {
  index: number;
  path: string;
  oldText: string;
  newText: string;
  startLine?: number;
  expectedSha256: string;
  absolutePath?: string;
  guard?: WorkspacePathGuardResult;
}

interface PreparedEdit extends NormalizedEdit {
  absolutePath: string;
  snapshot: WorkspaceMutationSnapshot;
  prepared: PreparedWorkspaceFileMutation;
  startLine: number;
}

function publicMutationPath(workspaceRoot: string, absolutePath: string): string {
  const value = relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
  return value || ".";
}

function decodeUtf8(data: Buffer):
  | { ok: true; text: string }
  | { ok: false; error: "binary_file_not_supported" | "invalid_utf8" } {
  if (data.subarray(0, Math.min(data.length, 4096)).includes(0)) {
    return { ok: false, error: "binary_file_not_supported" };
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) };
  } catch {
    return { ok: false, error: "invalid_utf8" };
  }
}

function invalidArguments(message: string, recoveryHint: string) {
  return {
    ok: false as const,
    error: "invalid_arguments",
    message,
    recovery_hint: recoveryHint,
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "edit_file", ok: false, error: "invalid_arguments" }),
  };
}

function noChangeRequested(index: number) {
  return {
    ok: false as const,
    error: "no_change_requested",
    message: `edits[${index}] has identical old_text and new_text, so no file change was requested.`,
    recovery_hint: "Remove the unchanged entry and continue with only material edits.",
    evidence_capability_receipts: fileToolCapabilityReceipt({
      toolName: "edit_file",
      ok: false,
      error: "no_change_requested",
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStartLine(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : "invalid";
}

export function normalizeBatchEdits(value: unknown):
  | { ok: true; edits: NormalizedEdit[] }
  | { ok: false; result: ReturnType<typeof invalidArguments> | ReturnType<typeof noChangeRequested> } {
  if (!Array.isArray(value) || value.length < BATCH_MIN_EDITS || value.length > BATCH_MAX_EDITS) {
    return {
      ok: false,
      result: invalidArguments(`edits must contain ${BATCH_MIN_EDITS}-${BATCH_MAX_EDITS} entries.`, `Retry with ${BATCH_MIN_EDITS}-${BATCH_MAX_EDITS} exact edit entries.`),
    };
  }
  const edits: NormalizedEdit[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { ok: false, result: invalidArguments(`edits[${index}] must be an object.`, "Retry with canonical edit objects.") };
    const allowed = new Set(["path", "start_line", "old_text", "new_text", "expected_sha256"]);
    const unknown = Object.keys(item).find((key) => !allowed.has(key));
    if (unknown) return { ok: false, result: invalidArguments(`Unknown edits[${index}] field: ${unknown}.`, "Use only path, start_line, old_text, new_text, and expected_sha256.") };
    if (typeof item.path !== "string" || !item.path.trim()) return { ok: false, result: invalidArguments(`edits[${index}].path is required.`, "Retry with workspace-relative paths.") };
    if (typeof item.old_text !== "string" || item.old_text.length === 0) return { ok: false, result: invalidArguments(`edits[${index}].old_text must be non-empty.`, "Copy each exact existing text range.") };
    if (typeof item.new_text !== "string") return { ok: false, result: invalidArguments(`edits[${index}].new_text must be a string.`, "Use an empty string to remove text or provide replacement text.") };
    if (item.old_text === item.new_text) return { ok: false, result: noChangeRequested(index) };
    const startLine = normalizeStartLine(item.start_line);
    if (startLine === "invalid") return { ok: false, result: invalidArguments(`edits[${index}].start_line must be a positive integer.`, "Retry with one-based line hints or omit them.") };
    const expectedSha256 = normalizeWorkspaceSha256(item.expected_sha256);
    if (expectedSha256 === undefined) return { ok: false, result: invalidArguments(`edits[${index}].expected_sha256 must be a 64-character hexadecimal SHA-256 digest.`, "Read every file and provide its complete lowercase or uppercase SHA-256.") };
    edits.push({
      index,
      path: item.path.trim(),
      oldText: item.old_text,
      newText: item.new_text,
      ...(startLine === undefined ? {} : { startLine }),
      expectedSha256,
    });
  }
  return { ok: true, edits };
}

function targetKey(guard: WorkspacePathGuardResult): string {
  const value = (guard.realPath ?? guard.absolutePath ?? "").replaceAll("\\", "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function batchRecord(input: {
  path?: string;
  index: number;
  error?: string;
  before_sha256?: string;
  current_sha256?: string;
  after_sha256?: string;
  bytes?: number;
  start_line?: number;
  cleanup_failed?: boolean;
  changed_file?: import("../shared/changed-file-detail.ts").ChangedFileDetail;
}) {
  return {
    index: input.index,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.before_sha256 === undefined ? {} : { before_sha256: input.before_sha256 }),
    ...(input.current_sha256 === undefined ? {} : { current_sha256: input.current_sha256 }),
    ...(input.after_sha256 === undefined ? {} : { after_sha256: input.after_sha256 }),
    ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
    ...(input.start_line === undefined ? {} : { start_line: input.start_line }),
    ...(input.cleanup_failed === undefined ? {} : { cleanup_failed: input.cleanup_failed }),
    ...(input.changed_file === undefined ? {} : { changed_file: input.changed_file }),
  };
}

function batchFailureResult(
  edits: readonly NormalizedEdit[],
  failures: readonly Record<string, unknown>[],
  safePaths: ReadonlyMap<number, string | undefined>,
) {
  const paths = [...new Set(
    edits
      .map((edit) => safePaths.get(edit.index))
      .filter((path): path is string => typeof path === "string"),
  )];
  return {
    ok: false as const,
    error: "batch_preflight_failed",
    message: "No files were changed because at least one batch edit failed preflight.",
    recovery_hint: "Resolve every listed file error and retry the complete batch.",
    preflight_failures: failures,
    applied: [],
    conflicting: [],
    not_attempted: edits.map((edit) => batchRecord({ path: safePaths.get(edit.index), index: edit.index })),
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "edit_file", ok: false, error: "batch_preflight_failed", paths }),
  };
}

function partialResult(input: {
  error: string;
  message: string;
  recoveryHint: string;
  applied: readonly Record<string, unknown>[];
  conflicting: readonly Record<string, unknown>[];
  notAttempted: readonly Record<string, unknown>[];
  paths: readonly string[];
}) {
  return {
    ok: false as const,
    error: input.error,
    message: input.message,
    recovery_hint: input.recoveryHint,
    applied: input.applied,
    conflicting: input.conflicting,
    not_attempted: input.notAttempted,
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "edit_file", ok: false, error: input.error, paths: input.paths, applied: input.applied, conflicting: input.conflicting, not_attempted: input.notAttempted }),
  };
}

export async function executeBatchEdits(edits: NormalizedEdit[], args: Record<string, unknown>, context: FileToolExecutionContext) {
  const workspaceRoot = getWorkspaceRoot(
    args,
    context.workspaceReference?.get() ?? context.workspacePath,
  );
  const guardedEdits: NormalizedEdit[] = [];
  const failures: Record<string, unknown>[] = [];
  const seenTargets = new Set<string>();
  const safePaths = new Map<number, string | undefined>();
  for (const edit of edits) {
    const guard = await resolveWorkspacePathGuard({ workspaceRoot, relativePath: edit.path, relativeOnly: context.allowedToolsAndEffects !== undefined, mutation: true, programHome: context.butlerHome, rejectProtectedProjectLedgerWrites: true, protectedProjectLedgerRoots: context.protectedProjectLedgerRoots });
    if (!guard.ok) {
      const safePath = safeWorkspaceResultPath({
        workspaceRoot: guard.workspaceRoot,
        requestedPath: edit.path,
        absolutePath: guard.absolutePath,
      });
      safePaths.set(edit.index, safePath);
      failures.push({
        index: edit.index,
        ...(safePath === undefined ? {} : { path: safePath }),
        error: guard.reason ?? "path_rejected",
        guard: safeWorkspaceGuardResult(guard),
      });
      continue;
    }
    const path = publicMutationPath(guard.workspaceRoot, guard.absolutePath!);
    safePaths.set(edit.index, path);
    const key = targetKey(guard);
    if (seenTargets.has(key)) {
      failures.push({ index: edit.index, path, error: "duplicate_target" });
      continue;
    }
    seenTargets.add(key);
    guardedEdits.push({ ...edit, path, absolutePath: guard.absolutePath!, guard });
  }
  if (failures.length > 0) return batchFailureResult(edits, failures, safePaths);

  const startedAt = Date.now();
  return withButlerFileMutationLock(async () => {
    const preparedEdits: PreparedEdit[] = [];
    const preflightFailures: Record<string, unknown>[] = [];
    for (const edit of guardedEdits) {
      const snapshot = await observeWorkspaceFileMutation({ path: edit.path, absolutePath: edit.absolutePath! });
      if (!snapshot.ok) { preflightFailures.push({ index: edit.index, path: edit.path, error: snapshot.error }); continue; }
      if (!snapshot.exists) { preflightFailures.push({ index: edit.index, path: edit.path, error: "not_found" }); continue; }
      const decoded = decodeUtf8(snapshot.bytes);
      if (!decoded.ok) { preflightFailures.push({ index: edit.index, path: edit.path, error: decoded.error }); continue; }
      const guarded = prepareWorkspaceFileMutation({ snapshot, data: snapshot.bytes, expectedSha256: edit.expectedSha256 });
      if (!guarded.ok) { preflightFailures.push({ index: edit.index, path: edit.path, error: guarded.error, before_sha256: guarded.before_sha256 }); continue; }
      const location = locateExactText({ text: decoded.text, oldText: edit.oldText, ...(edit.startLine === undefined ? {} : { startLine: edit.startLine }) });
      if (!location.ok) { preflightFailures.push({ index: edit.index, path: edit.path, error: location.error, occurrences: location.occurrenceCount }); continue; }
      const afterText = `${decoded.text.slice(0, location.value.offset)}${edit.newText}${decoded.text.slice(location.value.offset + edit.oldText.length)}`;
      const prepared = prepareWorkspaceFileMutation({ snapshot, data: Buffer.from(afterText, "utf8"), expectedSha256: edit.expectedSha256 });
      if (!prepared.ok) { preflightFailures.push({ index: edit.index, path: edit.path, error: prepared.error, before_sha256: prepared.before_sha256 }); continue; }
      preparedEdits.push({ ...edit, absolutePath: edit.absolutePath!, snapshot, prepared, startLine: location.value.startLine });
    }
    if (preflightFailures.length > 0) return batchFailureResult(edits, preflightFailures, safePaths);

    const paths = preparedEdits.map((edit) => edit.path);
    const committedBatch = await commitWorkspaceFileMutationBatch(preparedEdits.map((edit) => edit.prepared));
    const applied: Record<string, unknown>[] = committedBatch.applied.map((entry) => {
      const edit = preparedEdits[entry.index]!;
      return batchRecord({
        index: edit.index,
        path: edit.path,
        before_sha256: entry.result.before_sha256,
        after_sha256: entry.result.after_sha256,
        bytes: entry.result.bytes,
        start_line: edit.startLine,
        ...(entry.result.cleanup_failed ? { cleanup_failed: true } : {}),
        ...(entry.result.changed_file ? { changed_file: entry.result.changed_file } : {}),
      });
    });
    if (!committedBatch.ok) {
      const conflict = committedBatch.conflicting[0]!;
      const conflictEdit = preparedEdits[conflict.index]!;
      const conflicting = [batchRecord({
        index: conflictEdit.index,
        path: conflictEdit.path,
        error: conflict.result.error,
        before_sha256: conflict.result.before_sha256,
        current_sha256: conflict.result.current_sha256,
      })];
      const notAttempted = committedBatch.not_attempted.map((entry) => {
        const edit = preparedEdits[entry.index]!;
        return batchRecord({ index: edit.index, path: edit.path });
      });
      return partialResult({
        error: committedBatch.error,
        message: committedBatch.error === "external_change_conflict"
          ? "The batch was not applied because its first target changed after preflight."
          : committedBatch.error === "partial_apply"
            ? "The batch stopped after a file changed or failed; committed files were not rolled back."
            : `The batch was not applied because the first commit failed with ${committedBatch.error}.`,
        recoveryHint: committedBatch.error === "external_change_conflict"
          ? "Re-read the conflicting file and retry the complete batch from current SHA-256 values."
          : committedBatch.error === "partial_apply"
            ? "Review applied and conflicting files, then re-read and retry only the remaining intended edits."
            : "Resolve the first file error, re-read every target, and retry the complete batch.",
        applied,
        conflicting,
        notAttempted,
        paths,
      });
    }

    const bytesWritten = applied.reduce((total, item) => total + (typeof item.bytes === "number" ? item.bytes : 0), 0);
    return {
      ok: true as const,
      files: applied,
      applied,
      changed_files: applied.flatMap((entry) =>
        "changed_file" in entry && entry.changed_file ? [entry.changed_file] : []),
      metrics: { elapsed_ms: Math.max(0, Date.now() - startedAt), files_written: applied.length, bytes_written: bytesWritten },
      evidence_receipts: fileToolEvidenceReceipt({ toolName: "edit_file", summary: `Edited ${applied.length} workspace files`, references: { batch: true, applied }, satisfies: ["durable_artifact"] }),
      evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "edit_file", ok: true, paths, applied, edited: true, bytes: bytesWritten }),
    };
  });
}
