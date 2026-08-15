import { relative } from "node:path";
import {
  resolveWorkspacePathGuard,
  safeWorkspaceGuardResult,
  safeWorkspaceResultPath,
} from "../shared/workspace-path-guard.ts";
import {
  commitWorkspaceFileMutation,
  ensureWorkspaceMutationParent,
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
import { getWorkspaceRoot, tryParseToolArgs } from "../shared/args.ts";
import { normalizeWorkspaceSha256 } from "../shared/workspace-sha256.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";

function publicMutationPath(workspaceRoot: string, absolutePath: string): string {
  const value = relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
  return value || ".";
}

function failedResult(
  failure: WorkspaceMutationFailure,
  extra: Record<string, unknown> = {},
) {
  return {
    ok: false as const,
    error: failure.error,
    ...(failure.path ? { path: failure.path } : {}),
    message: failure.message,
    recovery_hint: failure.recovery_hint,
    ...(failure.before_sha256 === undefined ? {} : { before_sha256: failure.before_sha256 }),
    ...(failure.expected_sha256 === undefined ? {} : { expected_sha256: failure.expected_sha256 }),
    ...extra,
    evidence_capability_receipts: fileToolCapabilityReceipt({
      toolName: "write_file",
      ok: false,
      path: failure.path || undefined,
      error: failure.error,
    }),
  };
}

function parseFailure(error: string, detail: string) {
  return {
    ok: false as const,
    error,
    detail,
    message: "Tool arguments must be a JSON object.",
    recovery_hint: "Retry write_file with path, content, and overwrite.",
    evidence_capability_receipts: fileToolCapabilityReceipt({
      toolName: "write_file",
      ok: false,
      error,
    }),
  };
}

export async function executeWriteFileTool(
  call: { arguments?: unknown; input?: unknown; args?: unknown },
  context: FileToolExecutionContext = {},
) {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) return parseFailure(parsed.error, parsed.detail);

  const args = parsed.args;
  const workspaceRoot = getWorkspaceRoot(
    args,
    context.workspaceReference?.get() ?? context.workspacePath,
  );
  const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
  const content = typeof args.content === "string" ? args.content : undefined;
  // Preserve the established runtime default for direct callers while the
  // canonical schema continues to advertise overwrite as required.
  const overwrite = args.overwrite === undefined ? false : args.overwrite;
  const createParents = args.create_parents === true;
  const expectedSha256 = normalizeWorkspaceSha256(args.expected_sha256);
  const suppliedExpectedSha256 = args.expected_sha256 !== undefined;
  if (!requestedPath || content === undefined || typeof overwrite !== "boolean") {
    const safePath = safeWorkspaceResultPath({ workspaceRoot, requestedPath });
    return failedResult(workspaceMutationFailure(
      safePath ?? "",
      "invalid_arguments",
      { message: "write_file requires path, content, and boolean overwrite.", recovery_hint: "Retry with path, content, and overwrite=false or true." },
    ));
  }
  if (suppliedExpectedSha256 && expectedSha256 === undefined) {
    const safePath = safeWorkspaceResultPath({ workspaceRoot, requestedPath });
    return failedResult(workspaceMutationFailure(
      safePath ?? "",
      "invalid_arguments",
      {
        message: "expected_sha256 must be a 64-character hexadecimal SHA-256 digest.",
        recovery_hint: "Retry with the complete current lowercase or uppercase SHA-256.",
      },
    ));
  }

  const guard = await resolveWorkspacePathGuard({
    workspaceRoot,
    relativePath: requestedPath,
    allowMissingLeaf: true,
    rejectProtectedProjectLedgerWrites: true,
    protectedProjectLedgerRoots: context.protectedProjectLedgerRoots,
  });
  if (!guard.ok) {
    const safePath = safeWorkspaceResultPath({
      workspaceRoot: guard.workspaceRoot,
      requestedPath,
      absolutePath: guard.absolutePath,
    });
    return {
      ok: false as const,
      error: guard.reason,
      ...(safePath === undefined ? {} : { path: safePath }),
      guard: safeWorkspaceGuardResult(guard),
      message: "The requested workspace path was rejected.",
      recovery_hint: "Retry with a regular workspace-relative file path.",
      evidence_capability_receipts: fileToolCapabilityReceipt({
        toolName: "write_file",
        ok: false,
        path: safePath,
        error: guard.reason,
      }),
    };
  }

  const path = publicMutationPath(guard.workspaceRoot, guard.absolutePath!);
  const startedAt = Date.now();
  return withButlerFileMutationLock(async () => {
    const snapshot = await observeWorkspaceFileMutation({
      path,
      absolutePath: guard.absolutePath!,
      createParents,
    });
    if (!snapshot.ok) return failedResult(snapshot);
    if (snapshot.exists && !overwrite) {
      return failedResult(workspaceMutationFailure(path, "file_exists", {
        before_sha256: snapshot.sha256,
      }));
    }
    if (!snapshot.exists && overwrite) {
      return failedResult(workspaceMutationFailure(path, "invalid_arguments", {
        message: "Creation requires overwrite=false.",
        recovery_hint: "Retry creation with overwrite=false.",
      }));
    }

    const prepared = prepareWorkspaceFileMutation({
      snapshot,
      data: Buffer.from(content, "utf8"),
      expectedSha256,
      requireExpectedForExisting: true,
    });
    if (!prepared.ok) return failedResult(prepared);

    const parentFailure = await ensureWorkspaceMutationParent({
      path,
      absolutePath: guard.absolutePath!,
      createParents,
      workspaceRoot: guard.workspaceRoot,
    });
    if (parentFailure) return failedResult(parentFailure);

    const committed = await commitWorkspaceFileMutation(prepared);
    if (!committed.ok) return failedResult(committed);
    return {
      ok: true as const,
      path: committed.path,
      created: committed.created,
      overwritten: committed.overwritten,
      bytes: committed.bytes,
      before_sha256: committed.before_sha256,
      after_sha256: committed.after_sha256,
      atomic_write: true as const,
      ...(committed.cleanup_failed ? { cleanup_failed: true } : {}),
      create_parents: createParents,
      metrics: { elapsed_ms: Math.max(0, Date.now() - startedAt), files_written: 1, bytes_written: committed.bytes },
      evidence_receipts: fileToolEvidenceReceipt({
        toolName: "write_file",
        summary: `${committed.created ? "Created" : "Overwrote"} workspace file ${committed.path}`,
        references: {
          path: committed.path,
          created: committed.created,
          overwritten: committed.overwritten,
          before_sha256: committed.before_sha256,
          after_sha256: committed.after_sha256,
          atomic_write: true,
          ...(committed.cleanup_failed ? { cleanup_failed: true } : {}),
          create_parents: createParents,
        },
        satisfies: ["durable_artifact"],
      }),
      evidence_capability_receipts: fileToolCapabilityReceipt({
        toolName: "write_file",
        ok: true,
        path: committed.path,
        created: committed.created,
        overwritten: committed.overwritten,
        bytes: committed.bytes,
      }),
    };
  });
}
