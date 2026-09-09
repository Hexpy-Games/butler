import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./evidence.ts";
import {
  isNodeFsError,
  mapWorkspaceMutationReadFailure,
  workspaceMutationFailure,
} from "./workspace-mutation-errors.ts";
import { normalizeWorkspaceSha256 } from "./workspace-sha256.ts";
import { changedFileDetail, type ChangedFileDetail } from "./changed-file-detail.ts";
export { withButlerFileMutationLock } from "./workspace-file-mutation-lock.ts";
export { workspaceMutationFailure } from "./workspace-mutation-errors.ts";

/** Stable failures emitted by the shared file mutation boundary. */
export type WorkspaceMutationError =
  | "invalid_arguments"
  | "target_not_regular_file"
  | "not_found"
  | "file_exists"
  | "expected_sha256_required"
  | "expected_sha256_mismatch"
  | "expected_sha256_on_missing_file"
  | "external_change_conflict"
  | "parent_directory_missing"
  | "parent_directory_unwritable"
  | "permission_denied"
  | "io_error"
  | "tool_not_admitted";

export interface WorkspaceMutationFailure {
  ok: false;
  error: WorkspaceMutationError;
  path: string;
  message: string;
  recovery_hint: string;
  before_sha256?: string;
  expected_sha256?: string;
  current_sha256?: string;
  committed?: boolean;
}

export interface WorkspaceMutationSnapshot {
  ok: true;
  path: string;
  /** Internal absolute path. Never copy this field into a tool result. */
  absolutePath: string;
  exists: boolean;
  bytes: Buffer;
  sha256?: string;
  mode?: number;
}

export interface PreparedWorkspaceFileMutation {
  ok: true;
  path: string;
  /** Internal absolute path. Never copy this field into a tool result. */
  absolutePath: string;
  before: WorkspaceMutationSnapshot;
  data: Buffer;
  mode?: number;
  create: boolean;
}

export interface CommittedWorkspaceFileMutation {
  ok: true;
  path: string;
  created: boolean;
  overwritten: boolean;
  bytes: number;
  before_sha256?: string;
  after_sha256: string;
  atomic_write: true;
  cleanup_failed?: boolean;
  changed_file?: ChangedFileDetail;
}

export type WorkspaceMutationResult =
  | CommittedWorkspaceFileMutation
  | WorkspaceMutationFailure;

async function checkExistingParent(
  absolutePath: string,
  path: string,
): Promise<WorkspaceMutationFailure | null> {
  const parent = dirname(absolutePath);
  try {
    // Follow an admitted in-workspace directory alias here; the public path
    // guard has already checked its realpath remains inside the workspace.
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) return workspaceMutationFailure(path, "parent_directory_missing");
    await access(parent, constants.W_OK);
    return null;
  } catch (error) {
    if (isNodeFsError(error) && error.code === "ENOENT") {
      return workspaceMutationFailure(path, "parent_directory_missing");
    }
    if (isNodeFsError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      return workspaceMutationFailure(path, "parent_directory_unwritable");
    }
    return workspaceMutationFailure(path, "io_error");
  }
}

/**
 * Create a mutation parent only after all target and content preflight checks
 * have passed. Observation deliberately never calls this function.
 */
export async function ensureWorkspaceMutationParent(input: {
  path: string;
  absolutePath: string;
  createParents?: boolean;
  workspaceRoot?: string;
}): Promise<WorkspaceMutationFailure | null> {
  const parent = dirname(input.absolutePath);
  if (!input.createParents) return checkExistingParent(input.absolutePath, input.path);

  // Verify the nearest existing ancestor remains inside the guarded root
  // before recursive mkdir. This preserves the path guard's symlink policy for
  // a parent chain that did not exist during the initial guard call.
  if (input.workspaceRoot) {
    const root = resolve(input.workspaceRoot);
    let ancestor = parent;
    while (true) {
      const ancestorReal = await realpath(ancestor).catch(() => undefined);
      if (ancestorReal) {
        const rootReal = await realpath(root).catch(() => root);
        const rel = relative(rootReal, ancestorReal);
        if (isAbsolute(rel) || rel.startsWith("..")) {
          return workspaceMutationFailure(input.path, "io_error", {
            message: "The mutation parent escaped the workspace during preflight.",
            recovery_hint: "Retry after restoring a regular workspace-relative parent directory.",
          });
        }
        break;
      }
      const next = dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }

  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    if (isNodeFsError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      return workspaceMutationFailure(input.path, "parent_directory_unwritable");
    }
    if (isNodeFsError(error) && error.code === "ENOENT") {
      return workspaceMutationFailure(input.path, "parent_directory_missing");
    }
    return workspaceMutationFailure(input.path, "io_error");
  }

  const parentFailure = await checkExistingParent(input.absolutePath, input.path);
  if (parentFailure) return parentFailure;
  if (input.workspaceRoot) {
    const root = await realpath(resolve(input.workspaceRoot)).catch(() => resolve(input.workspaceRoot!));
    const parentReal = await realpath(parent).catch(() => undefined);
    if (!parentReal) return workspaceMutationFailure(input.path, "parent_directory_missing");
    const rel = relative(root, parentReal);
    if (isAbsolute(rel) || rel.startsWith("..")) {
      return workspaceMutationFailure(input.path, "io_error", {
        message: "The mutation parent escaped the workspace during creation.",
        recovery_hint: "Retry after restoring a regular workspace-relative parent directory.",
      });
    }
  }
  return null;
}

/** Read a guarded target once for mutation preflight. */
export async function observeWorkspaceFileMutation(input: {
  path: string;
  absolutePath: string;
  createParents?: boolean;
}): Promise<WorkspaceMutationSnapshot | WorkspaceMutationFailure> {
  // Observation is intentionally non-mutating. Callers create parents only
  // after target/overwrite/expected-SHA/content preflight succeeds.
  if (!input.createParents) {
    const parentFailure = await checkExistingParent(input.absolutePath, input.path);
    if (parentFailure) return parentFailure;
  }

  let target;
  try {
    target = await lstat(input.absolutePath);
  } catch (error) {
    if (isNodeFsError(error) && error.code === "ENOENT") {
      return {
        ok: true,
        path: input.path,
        absolutePath: input.absolutePath,
        exists: false,
        bytes: Buffer.alloc(0),
      };
    }
    return mapWorkspaceMutationReadFailure(input.path, error);
  }

  if (!target.isFile()) return workspaceMutationFailure(input.path, "target_not_regular_file");

  let bytes: Buffer;
  try {
    bytes = await readFile(input.absolutePath);
  } catch (error) {
    return mapWorkspaceMutationReadFailure(input.path, error);
  }
  return {
    ok: true,
    path: input.path,
    absolutePath: input.absolutePath,
    exists: true,
    bytes,
    sha256: sha256Hex(bytes),
    mode: target.mode,
  };
}

/**
 * Validate a preflight snapshot and bind the desired bytes to it. This is the
 * only preparation owner used by write_file and edit_file.
 */
export function prepareWorkspaceFileMutation(input: {
  snapshot: WorkspaceMutationSnapshot;
  data: Buffer;
  expectedSha256?: string;
  requireExpectedForExisting?: boolean;
}): PreparedWorkspaceFileMutation | WorkspaceMutationFailure {
  const { snapshot } = input;
  const expectedSha256 = normalizeWorkspaceSha256(input.expectedSha256);
  if (input.expectedSha256 !== undefined && expectedSha256 === undefined) {
    return workspaceMutationFailure(snapshot.path, "invalid_arguments", {
      message: "expected_sha256 must be a 64-character hexadecimal SHA-256 digest.",
      recovery_hint: "Retry with the complete current lowercase or uppercase SHA-256.",
    });
  }
  if (snapshot.exists) {
    if (input.requireExpectedForExisting && !expectedSha256) {
      return workspaceMutationFailure(snapshot.path, "expected_sha256_required");
    }
    if (expectedSha256 !== undefined && expectedSha256 !== snapshot.sha256) {
      return workspaceMutationFailure(snapshot.path, "expected_sha256_mismatch", {
        before_sha256: snapshot.sha256,
        expected_sha256: expectedSha256,
      });
    }
  } else if (expectedSha256 !== undefined) {
    return workspaceMutationFailure(snapshot.path, "expected_sha256_on_missing_file", {
      expected_sha256: expectedSha256,
    });
  }
  return {
    ok: true,
    path: snapshot.path,
    absolutePath: snapshot.absolutePath,
    before: snapshot,
    data: input.data,
    mode: snapshot.mode,
    create: !snapshot.exists,
  };
}

async function atomicReplace(
  prepared: PreparedWorkspaceFileMutation,
): Promise<{ cleanup_failed?: boolean }> {
  const temporaryPath = `${prepared.absolutePath}.butler-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, prepared.data, {
      flag: "wx",
      ...(prepared.mode === undefined ? {} : { mode: prepared.mode }),
    });
    if (prepared.create) {
      // link() is an exclusive create, so a target that appears after the
      // immediate re-observation cannot be replaced by a stale create.
      await link(temporaryPath, prepared.absolutePath);
      return cleanupCommittedWorkspaceCreate(temporaryPath);
    } else {
      await rename(temporaryPath, prepared.absolutePath);
      return {};
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Remove a committed create's temporary hardlink without changing the
 * already-applied result when cleanup is unavailable. This is intentionally a
 * tiny production helper so its failure state can be tested at the same real
 * boundary without a test-only executor composition.
 */
export async function cleanupCommittedWorkspaceCreate(
  temporaryPath: string,
): Promise<{ cleanup_failed: boolean }> {
  try {
    await rm(temporaryPath, { force: true });
    return { cleanup_failed: false };
  } catch {
    // link() is the commit point. Do not turn a cleanup-only failure into a
    // false-negative mutation result.
    return { cleanup_failed: true };
  }
}

/**
 * Re-observe immediately before same-directory atomic replacement and commit
 * only when the preflight revision still matches.
 */
export async function commitWorkspaceFileMutation(
  prepared: PreparedWorkspaceFileMutation,
): Promise<WorkspaceMutationResult> {
  const current = await observeWorkspaceFileMutation({
    path: prepared.path,
    absolutePath: prepared.absolutePath,
  });
  if (!current.ok) {
    if (
      current.error === "not_found" ||
      current.error === "target_not_regular_file" ||
      current.error === "permission_denied" ||
      current.error === "io_error"
    ) {
      if (
        (prepared.before.exists && (current.error === "not_found" || current.error === "target_not_regular_file")) ||
        (!prepared.before.exists && current.error === "target_not_regular_file")
      ) {
        return workspaceMutationFailure(prepared.path, "external_change_conflict", {
          before_sha256: prepared.before.sha256,
          current_sha256: current.current_sha256,
        });
      }
    }
    return current;
  }

  const revisionChanged = prepared.before.exists !== current.exists
    || prepared.before.sha256 !== current.sha256
    || prepared.before.mode !== current.mode;
  if (revisionChanged) {
    return workspaceMutationFailure(prepared.path, "external_change_conflict", {
      before_sha256: prepared.before.sha256,
      current_sha256: current.sha256,
    });
  }

  let cleanup_failed: boolean | undefined;
  try {
    ({ cleanup_failed } = await atomicReplace(prepared));
  } catch (error) {
    const mapped = isNodeFsError(error)
      && (error.code === "EACCES" || error.code === "EPERM")
      ? workspaceMutationFailure(prepared.path, "permission_denied")
      : isNodeFsError(error) && error.code === "EEXIST" && prepared.create
        ? workspaceMutationFailure(prepared.path, "external_change_conflict")
        : workspaceMutationFailure(prepared.path, "io_error");
    return mapped;
  }

  const detail = changedFileDetail(
    prepared.path,
    prepared.before.bytes,
    prepared.data,
    { created: prepared.create },
  );

  return {
    ok: true,
    path: prepared.path,
    created: prepared.create,
    overwritten: !prepared.create,
    bytes: prepared.data.length,
    before_sha256: prepared.before.sha256,
    after_sha256: sha256Hex(prepared.data),
    atomic_write: true,
    ...(cleanup_failed ? { cleanup_failed: true } : {}),
    ...(detail ? { changed_file: detail } : {}),
  };
}
