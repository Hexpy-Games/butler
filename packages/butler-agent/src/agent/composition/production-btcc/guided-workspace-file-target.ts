import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import type { EffectAdapterError } from "../../btcc/effects/index.ts";
import { resolveWorkspacePathGuard } from "../../tools/file-tools/index.ts";

const WORKSPACE_TARGET_PREFIX = "workspace:";
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

export type ObservedWorkspaceFileTarget =
  | { status: "file"; bytes: number; sha256: string }
  | { status: "missing" }
  | { status: "unavailable"; error: EffectAdapterError };

type GuardedWorkspaceFileTarget = {
  absolutePath: string;
};

export function workspaceFileEffectTarget(path: string): string {
  return `${WORKSPACE_TARGET_PREFIX}${normalizeWorkspaceRelativePath(path)}`;
}

export function normalizeWorkspaceFileTarget(target: string): string {
  const value = requiredString(target, "target");
  if (!value.startsWith(WORKSPACE_TARGET_PREFIX)) {
    throw new Error(
      `write_file effect target must use ${WORKSPACE_TARGET_PREFIX}<relative-path>`,
    );
  }
  return workspaceFileEffectTarget(value.slice(WORKSPACE_TARGET_PREFIX.length));
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const trimmed = requiredString(value, "path");
  if (trimmed.includes("\0")) {
    throw new Error("write_file effect path contains a null byte");
  }
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed)) {
    throw new Error("write_file effect path must be workspace-relative");
  }
  const slashPath = trimmed.replaceAll("\\", "/");
  if (slashPath.split("/").includes("..")) {
    throw new Error("write_file effect path cannot traverse a parent directory");
  }
  const normalized = posix.normalize(slashPath).replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("/")) {
    throw new Error("write_file effect path must identify one workspace file");
  }
  return normalized;
}

export function normalizeWorkspaceContainedPath(
  workspacePath: string,
  value: string,
): string {
  const trimmed = requiredString(value, "path");
  if (!isAbsolute(trimmed) && !win32.isAbsolute(trimmed)) {
    return normalizeWorkspaceRelativePath(trimmed);
  }
  const workspace = resolve(workspacePath);
  const absolute = resolve(trimmed);
  const contained = relative(workspace, absolute);
  if (
    contained === "" ||
    contained.startsWith("..") ||
    isAbsolute(contained)
  ) {
    throw new Error("write_file effect path must identify a file inside the workspace");
  }
  return normalizeWorkspaceRelativePath(contained);
}

export function normalizeExpectedSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("write_file effect expected_sha256 must be a SHA-256 hex value");
  }
  return value.toLowerCase();
}

export async function guardWorkspaceFileTarget(input: {
  workspacePath: string;
  protectedProjectLedgerRoots: string[];
  path: string;
}): Promise<
  | { ok: true; target: GuardedWorkspaceFileTarget }
  | { ok: false; error: EffectAdapterError }
> {
  try {
    const guard = await resolveWorkspacePathGuard({
      workspaceRoot: input.workspacePath,
      relativePath: input.path,
      allowMissingLeaf: true,
      rejectProtectedProjectLedgerWrites: true,
      protectedProjectLedgerRoots: input.protectedProjectLedgerRoots,
    });
    if (!guard.ok || !guard.absolutePath) {
      return {
        ok: false,
        error: {
          code: guard.reason ?? "workspace_target_rejected",
          message: "write_file target is outside the admitted workspace boundary.",
        },
      };
    }
    return { ok: true, target: { absolutePath: guard.absolutePath } };
  } catch {
    return {
      ok: false,
      error: {
        code: "workspace_target_unavailable",
        message: "write_file target containment could not be observed.",
      },
    };
  }
}

export async function observeWorkspaceFileTarget(
  target: GuardedWorkspaceFileTarget,
): Promise<ObservedWorkspaceFileTarget> {
  try {
    const targetStat = await stat(target.absolutePath);
    if (!targetStat.isFile()) {
      return {
        status: "unavailable",
        error: {
          code: "workspace_target_not_file",
          message: "write_file target is not a regular file.",
        },
      };
    }
    const bytes = await readFile(target.absolutePath);
    return {
      status: "file",
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  } catch (error) {
    if (isNodeFsError(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "unavailable",
      error: {
        code: "workspace_target_observation_failed",
        message: "write_file target bytes could not be observed.",
      },
    };
  }
}

export function expectedWorkspaceFileSha256(content: string): string {
  return sha256(Buffer.from(content, "utf8"));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`write_file effect ${field} must be a non-empty string`);
  }
  return value.trim();
}

function isNodeFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
