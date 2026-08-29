import { relative } from "node:path";
import { TextDecoder } from "node:util";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import {
  commitWorkspaceFileMutation,
  observeWorkspaceFileMutation,
  prepareWorkspaceFileMutation,
  workspaceMutationFailure,
  withButlerFileMutationLock,
  type WorkspaceMutationFailure,
} from "../shared/workspace-file-mutation.ts";
import {
  fileToolCapabilityReceipt,
  fileToolEvidenceReceipt,
} from "../shared/evidence.ts";
import {
  mutationScopeAllowsPath,
  resolveWorkspacePathGuard,
  safeWorkspaceGuardResult,
  safeWorkspaceResultPath,
} from "../shared/workspace-path-guard.ts";
import { normalizeWorkspaceSha256 } from "../shared/workspace-sha256.ts";
import { locateExactText } from "./exact-text-locator.ts";
import {
  executeBatchEdits,
  normalizeBatchEdits,
  type NormalizedEdit,
} from "./batch-executor.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

type ToolCall = { arguments?: unknown; input?: unknown; args?: unknown };

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
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
    };
  } catch {
    return { ok: false, error: "invalid_utf8" };
  }
}

function failure(
  input: {
    error: string;
    path?: string;
    message?: string;
    recoveryHint?: string;
    details?: Record<string, unknown>;
  },
) {
  return {
    ok: false as const,
    error: input.error,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.recoveryHint === undefined ? {} : { recovery_hint: input.recoveryHint }),
    ...input.details,
    evidence_capability_receipts: fileToolCapabilityReceipt({
      toolName: "edit_file",
      ok: false,
      path: input.path,
      error: input.error,
    }),
  };
}

function mutationFailureResult(
  input: WorkspaceMutationFailure,
  details: Record<string, unknown> = {},
) {
  return failure({
    error: input.error,
    path: input.path,
    message: input.message,
    recoveryHint: input.recovery_hint,
    details: {
      ...(input.before_sha256 === undefined ? {} : { before_sha256: input.before_sha256 }),
      ...(input.expected_sha256 === undefined ? {} : { expected_sha256: input.expected_sha256 }),
      ...(input.current_sha256 === undefined ? {} : { current_sha256: input.current_sha256 }),
      ...details,
    },
  });
}

function invalidArguments(message: string, recoveryHint: string) {
  return failure({ error: "invalid_arguments", message, recoveryHint });
}

function noChangeRequested(message: string) {
  return failure({
    error: "no_change_requested",
    message,
    recoveryHint: "Continue from the current file state and choose a materially different next action.",
  });
}

function normalizeStartLine(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : "invalid";
}

function normalizeSingleEdit(args: Record<string, unknown>):
  | { ok: true; edit: Omit<NormalizedEdit, "index"> }
  | { ok: false; result: ReturnType<typeof invalidArguments> } {
  const allowed = new Set(["path", "start_line", "old_text", "new_text", "expected_sha256", "workspace_root"]);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) {
    return { ok: false, result: invalidArguments(`Unknown single edit field: ${unknown}.`, "Use only path, start_line, old_text, new_text, and expected_sha256.") };
  }
  if (typeof args.path !== "string" || !args.path.trim()) {
    return { ok: false, result: invalidArguments("path is required for a single edit.", "Retry with a workspace-relative path.") };
  }
  if (typeof args.old_text !== "string" || args.old_text.length === 0) {
    return { ok: false, result: invalidArguments("old_text must be a non-empty string.", "Copy one exact existing text range into old_text.") };
  }
  if (typeof args.new_text !== "string") {
    return { ok: false, result: invalidArguments("new_text must be a string.", "Use an empty string to remove old_text or provide replacement text.") };
  }
  if (args.old_text === args.new_text) {
    return { ok: false, result: noChangeRequested("old_text and new_text are identical, so no file change was requested.") };
  }
  const startLine = normalizeStartLine(args.start_line);
  if (startLine === "invalid") {
    return { ok: false, result: invalidArguments("start_line must be a positive integer.", "Retry with a one-based line number or omit start_line.") };
  }
  const expectedSha256 = normalizeWorkspaceSha256(args.expected_sha256);
  if (args.expected_sha256 !== undefined && expectedSha256 === undefined) {
    return { ok: false, result: invalidArguments("expected_sha256 must be a 64-character hexadecimal SHA-256 digest when supplied.", "Retry with the complete current lowercase or uppercase SHA-256 or omit it.") };
  }
  return {
    ok: true,
    edit: {
      path: args.path.trim(),
      oldText: args.old_text,
      newText: args.new_text,
      ...(startLine === undefined ? {} : { startLine }),
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    } as Omit<NormalizedEdit, "index">,
  };
}

async function executeSingleEdit(
  edit: Omit<NormalizedEdit, "index">,
  context: FileToolExecutionContext,
  args: Record<string, unknown>,
) {
  const workspaceRoot = getWorkspaceRoot(
    args,
    context.workspaceReference?.get() ?? context.workspacePath,
  );
  if (!mutationScopeAllowsPath(edit.path, context.mutationScope)) {
    const safePath = safeWorkspaceResultPath({ workspaceRoot, requestedPath: edit.path });
    return mutationFailureResult(workspaceMutationFailure(safePath ?? "", "invalid_arguments", {
      message: "The requested path is outside the delegated mutation scope.",
      recovery_hint: "Retry only within the immutable Steward mutation scope.",
    }));
  }
  if (context.allowedToolsAndEffects &&
      !context.allowedToolsAndEffects.includes("edit_file:workspace")) {
    const safePath = safeWorkspaceResultPath({ workspaceRoot, requestedPath: edit.path });
    return mutationFailureResult(workspaceMutationFailure(safePath ?? "", "tool_not_admitted", {
      message: "The edit effect is not admitted for this Steward task.",
      recovery_hint: "Use only the exact mutation capability in the delegated packet.",
    }));
  }
  const guard = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: edit.path,
    relativeOnly: context.allowedToolsAndEffects !== undefined,
    rejectProtectedProjectLedgerWrites: true,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
  });
  if (!guard.ok) {
    const safePath = safeWorkspaceResultPath({
      workspaceRoot: guard.workspaceRoot,
      requestedPath: edit.path,
      absolutePath: guard.absolutePath,
    });
    return failure({
      error: guard.reason ?? "path_rejected",
      path: safePath,
      message: "The requested workspace path was rejected.",
      recoveryHint: "Retry with a regular workspace-relative file path.",
      details: { guard: safeWorkspaceGuardResult(guard) },
    });
  }
  const path = publicMutationPath(guard.workspaceRoot, guard.absolutePath!);
  const startedAt = Date.now();
  return withButlerFileMutationLock(async () => {
    const snapshot = await observeWorkspaceFileMutation({ path, absolutePath: guard.absolutePath! });
    if (!snapshot.ok) return mutationFailureResult(snapshot);
    if (!snapshot.exists) return mutationFailureResult(workspaceMutationFailure(path, "not_found"));

    const decoded = decodeUtf8(snapshot.bytes);
    if (!decoded.ok) {
      return failure({
        error: decoded.error,
        path,
        message: decoded.error === "binary_file_not_supported"
          ? "Binary files cannot be edited with exact text edits."
          : "The file is not valid UTF-8.",
        recoveryHint: "Choose a UTF-8 text file or use a purpose-built binary workflow.",
        details: { bytes: snapshot.bytes.length },
      });
    }

    const guarded = prepareWorkspaceFileMutation({
      snapshot,
      data: snapshot.bytes,
      expectedSha256: edit.expectedSha256,
    });
    if (!guarded.ok) return mutationFailureResult(guarded);

    const location = locateExactText({
      text: decoded.text,
      oldText: edit.oldText,
      ...(edit.startLine === undefined ? {} : { startLine: edit.startLine }),
    });
    if (!location.ok) {
      return failure({
        error: location.error,
        path,
        message: location.error === "old_text_ambiguous"
          ? "old_text occurs more than once in the target file."
          : "old_text was not found in the target file.",
        recoveryHint: "Retry with exact text and, when needed, a correct start_line hint.",
        details: {
          ...(edit.startLine === undefined ? {} : { start_line: edit.startLine }),
          before_sha256: snapshot.sha256,
          occurrences: location.occurrenceCount,
        },
      });
    }

    const afterText = `${decoded.text.slice(0, location.value.offset)}${edit.newText}${decoded.text.slice(location.value.offset + edit.oldText.length)}`;
    const prepared = prepareWorkspaceFileMutation({
      snapshot,
      data: Buffer.from(afterText, "utf8"),
      expectedSha256: edit.expectedSha256,
    });
    if (!prepared.ok) return mutationFailureResult(prepared);
    const committed = await commitWorkspaceFileMutation(prepared);
    if (!committed.ok) return mutationFailureResult(committed, {
      start_line: location.value.startLine,
    });

    return {
      ok: true as const,
      path,
      start_line: location.value.startLine,
      replacements: 1,
      bytes: committed.bytes,
      before_sha256: committed.before_sha256,
      after_sha256: committed.after_sha256,
      atomic_write: true as const,
      ...(committed.cleanup_failed ? { cleanup_failed: true } : {}),
      metrics: { elapsed_ms: Math.max(0, Date.now() - startedAt), files_written: 1, bytes_written: committed.bytes },
      evidence_receipts: fileToolEvidenceReceipt({
        toolName: "edit_file",
        summary: `Edited workspace file ${path}`,
        references: {
          path,
          start_line: location.value.startLine,
          replacements: 1,
          before_sha256: committed.before_sha256,
          after_sha256: committed.after_sha256,
          atomic_write: true,
          ...(committed.cleanup_failed ? { cleanup_failed: true } : {}),
        },
        satisfies: ["durable_artifact"],
      }),
      evidence_capability_receipts: fileToolCapabilityReceipt({
        toolName: "edit_file",
        ok: true,
        path,
        edited: true,
        overwritten: true,
        bytes: committed.bytes,
      }),
    };
  });
}

export async function executeEditFileTool(call: ToolCall, context: FileToolExecutionContext = {}) {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) {
    return failure({
      error: parsed.error,
      message: "Tool arguments must be a JSON object.",
      recoveryHint: "Retry edit_file with one exact edit or canonical edits batch.",
      details: { detail: parsed.detail },
    });
  }
  const args = parsed.args;
  const hasBatch = args.edits !== undefined;
  const hasSingle = ["path", "start_line", "old_text", "new_text", "expected_sha256"]
    .some((key) => args[key] !== undefined);
  if (hasBatch && hasSingle) {
    return invalidArguments("Provide exactly one of single edit fields or edits.", "Retry with either path/old_text/new_text or edits, never both.");
  }
  if (!hasBatch && !hasSingle) {
    return invalidArguments("Provide exactly one of single edit fields or edits.", "Retry with one exact edit or a 2-20 entry edits batch.");
  }
  if (hasBatch) {
    const normalized = normalizeBatchEdits(args.edits);
    if (!normalized.ok) return normalized.result;
    if (context.allowedToolsAndEffects &&
        !context.allowedToolsAndEffects.includes("edit_file:workspace")) {
      return failure({
        error: "tool_not_admitted",
        message: "The edit effect is not admitted for this Steward task.",
        recoveryHint: "Use only the exact mutation capability in the delegated packet.",
      });
    }
    if (normalized.edits.some((edit) => !mutationScopeAllowsPath(edit.path, context.mutationScope))) {
      return failure({
        error: "invalid_arguments",
        message: "The requested path is outside the delegated mutation scope.",
        recoveryHint: "Retry only within the immutable Steward mutation scope.",
      });
    }
    return executeBatchEdits(normalized.edits, args, context);
  }
  const normalized = normalizeSingleEdit(args);
  if (!normalized.ok) return normalized.result;
  return executeSingleEdit(normalized.edit, context, args);
}
