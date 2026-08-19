import { relative } from "node:path";
import {
  resolveWorkspacePathGuard,
  safeWorkspaceGuardResult,
  safeWorkspaceResultPath,
} from "../shared/workspace-path-guard.ts";
import { fileToolCapabilityReceipt, fileToolEvidenceReceipt } from "../shared/evidence.ts";
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import {
  cursorQueryHash,
  decodeFileToolCursor,
  encodeFileToolCursor,
  normalizeOptionalFileToolCursor,
} from "../shared/cursor.ts";
import {
  normalizeGlobArguments,
  normalizeTraversalLimits,
  traversalSupportsCursor,
  traverseWorkspaceFiles,
} from "../shared/workspace-traversal.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

function expectedQuery(input: {
  workspaceRoot: string;
  root: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  limits: ReturnType<typeof normalizeTraversalLimits>;
}): string {
  return cursorQueryHash({
    workspace_root: input.workspaceRoot,
    root: input.root,
    include_globs: input.includeGlobs,
    exclude_globs: input.excludeGlobs,
    limits: input.limits,
  });
}
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.floor(parsed), max)) : fallback;
}
function normalizeRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return ".";
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  return normalized || ".";
}

export async function executeListFilesTool(
  call: { arguments?: unknown; input?: unknown; args?: unknown },
  context: FileToolExecutionContext = {},
) {
  const startedAt = Date.now();
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) return {
    ok: false,
    error: parsed.error,
    detail: parsed.detail,
    message: "Tool arguments must be a JSON object.",
    recovery_hint: "Retry list_files with root, include_globs, exclude_globs, max_results, or cursor fields.",
    evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "list_files", ok: false, error: parsed.error }),
  };
  const args = parsed.args;
  const workspaceRoot = getWorkspaceRoot(
    args,
    context.workspaceReference?.get() ?? context.workspacePath,
  );
  const root = normalizeRoot(args.root);
  const includeResult = normalizeGlobArguments(args, "include_globs", "include");
  const excludeResult = normalizeGlobArguments(args, "exclude_globs", "exclude");
  if (!includeResult.ok) {
    const failure = includeResult;
    return {
      ok: false,
      error: failure.error,
      message: failure.message,
      recovery_hint: failure.recovery_hint,
      evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "list_files", ok: false, error: failure.error }),
    };
  }
  if (!excludeResult.ok) {
    const failure = excludeResult;
    return {
      ok: false,
      error: failure.error,
      message: failure.message,
      recovery_hint: failure.recovery_hint,
      evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "list_files", ok: false, error: failure.error }),
    };
  }
  const includeGlobs = includeResult.value;
  const excludeGlobs = excludeResult.value;
  const limits = normalizeTraversalLimits(args, { maxResults: boundedInteger(args.max_results, 100, 1, 1000) });
  const query = expectedQuery({ workspaceRoot, root, includeGlobs, excludeGlobs, limits });
  const cursorInput = normalizeOptionalFileToolCursor(args.cursor);
  const cursor = cursorInput === undefined ? null : decodeFileToolCursor(cursorInput);
  if (cursorInput !== undefined && (!cursor || cursor.tool !== "list_files" || cursor.query !== query)) {
    return {
      ok: false,
      error: "invalid_cursor",
      message: "The list_files cursor is malformed or does not match the current discovery options.",
      recovery_hint: "Restart list_files without cursor using the same root and glob filters.",
      metrics: { elapsed_ms: Math.max(0, Date.now() - startedAt) },
      evidence_capability_receipts: fileToolCapabilityReceipt({ toolName: "list_files", ok: false, error: "invalid_cursor" }),
    };
  }
  const guard = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: root,
    relativeOnly: context.allowedToolsAndEffects !== undefined,
    allowDirectories: true,
    requireDirectory: true,
    rejectProtectedProjectLedgerPaths: true,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
  });
  if (!guard.ok) {
    const error = guard.reason === "directory_not_allowed" || guard.reason === "not_a_directory"
      ? "not_a_directory"
      : guard.reason;
    const safePath = safeWorkspaceResultPath({
      workspaceRoot: guard.workspaceRoot,
      requestedPath: root,
      absolutePath: guard.absolutePath,
    });
    return {
      ok: false,
      error,
      ...(safePath === undefined ? {} : { path: safePath }),
      guard: safeWorkspaceGuardResult(guard),
      message: "The discovery root is not an admitted workspace directory.",
      recovery_hint: "Choose a contained, non-sensitive workspace directory.",
      evidence_capability_receipts: fileToolCapabilityReceipt({
        toolName: "list_files",
        ok: false,
        path: safePath,
        error,
      }),
    };
  }
  const traversal = await traverseWorkspaceFiles({
    workspaceRoot: guard.workspaceRoot,
    rootPath: guard.realPath ?? guard.absolutePath!,
    includeGlobs,
    excludeGlobs,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
    ...(cursor?.marker ? { afterPath: cursor.marker } : {}),
    limits,
  });
  const cursorMarker = traversal.lastFilePath ?? traversal.lastPath ?? traversal.entries[traversal.entries.length - 1]?.path;
  const nextCursor = traversal.truncated && traversalSupportsCursor(traversal.stoppedBy) && cursorMarker
    ? encodeFileToolCursor({ tool: "list_files", query, marker: cursorMarker })
    : undefined;
  const truncated = traversal.truncated;
  const files = traversal.entries.map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  const displayedRoot = relative(guard.workspaceRoot, guard.realPath ?? guard.absolutePath!).replace(/\\/g, "/") || ".";
  const result = {
    ok: true,
    root: displayedRoot,
    files,
    files_considered: traversal.filesConsidered,
    dirs_visited: traversal.dirsVisited,
    io_errors: traversal.ioErrors,
    truncated,
    ...(traversal.stoppedBy ? { stopped_by: traversal.stoppedBy } : {}),
    ...(traversal.stoppedBy && !traversalSupportsCursor(traversal.stoppedBy) ? { recovery_hint: traversal.stoppedBy === "io_error" ? "Discovery hit a workspace I/O error; retry list_files with a narrower admitted root or glob." : "Discovery stopped before a safe file boundary; narrow the root/globs or raise the directory/depth/time cap and retry without cursor." } : {}),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    metrics: {
      elapsed_ms: Math.max(0, Math.max(traversal.elapsedMs, Date.now() - startedAt)),
      files_considered: traversal.filesConsidered,
      files_returned: traversal.entries.length,
      dirs_visited: traversal.dirsVisited,
      io_errors: traversal.ioErrors,
    },
    evidence_receipts: fileToolEvidenceReceipt({
      toolName: "list_files",
      summary: `Discovered ${traversal.entries.length} workspace files${nextCursor ? " with bounded continuation" : truncated ? " with a bounded partial result" : ""}`,
      references: {
        root: displayedRoot,
        include_globs: includeGlobs,
        exclude_globs: excludeGlobs,
        files_considered: traversal.filesConsidered,
        dirs_visited: traversal.dirsVisited,
        io_errors: traversal.ioErrors,
        truncated,
        ...(traversal.stoppedBy ? { stopped_by: traversal.stoppedBy } : {}),
      },
      satisfies: [],
    }),
    evidence_capability_receipts: fileToolCapabilityReceipt({
      toolName: "list_files",
      ok: true,
      truncated,
      files,
      filesConsidered: traversal.filesConsidered,
      dirsVisited: traversal.dirsVisited,
    }),
  };
  return result;
}
