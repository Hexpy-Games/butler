import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { projectLedgerProtectedPath } from "./project-ledger-protection.ts";

export interface WorkspacePathGuardInput {
  workspaceRoot: string;
  relativePath: string;
  allowMissingLeaf?: boolean;
  allowDirectories?: boolean;
  rejectProtectedProjectLedgerPaths?: boolean;
  rejectProtectedProjectLedgerWrites?: boolean;
  protectedProjectLedgerRoots?: string[];
}

export interface WorkspacePathGuardResult {
  ok: boolean;
  workspaceRoot: string;
  requestedPath: string;
  absolutePath?: string;
  realPath?: string;
  reason?: string;
  code?: string;
  message?: string;
  next?: Array<{ command: string }>;
}

const SENSITIVE_SEGMENTS = new Set([".git", ".ssh", ".gnupg"]);
const SENSITIVE_FILENAMES = new Set(["chatgpt-oauth.json", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"]);

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function looksSensitiveWorkspacePath(pathValue: string): boolean {
  const parts = normalize(pathValue).split(/[\\/]+/).filter(Boolean);
  return parts.some((part, index) => {
    const lower = part.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(lower)) return true;
    if (SENSITIVE_FILENAMES.has(lower)) return true;
    if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
    if (index === parts.length - 1 && lower.startsWith(".env")) return true;
    return false;
  });
}

export async function resolveWorkspacePathGuard(input: WorkspacePathGuardInput): Promise<WorkspacePathGuardResult> {
  const requestedPath = input.relativePath;
  const workspaceRoot = resolve(input.workspaceRoot || ".");
  if (!requestedPath || typeof requestedPath !== "string") return { ok: false, workspaceRoot, requestedPath, reason: "missing_path" };
  const rootReal = await realpath(workspaceRoot);
  if (!isAbsolute(requestedPath) && requestedPath.split(/[\\/]+/).includes("..")) {
    return { ok: false, workspaceRoot: rootReal, requestedPath, reason: "parent_traversal_not_allowed" };
  }
  const unresolvedAbsolutePath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);
  const absolutePath = isInside(workspaceRoot, unresolvedAbsolutePath)
    ? resolve(rootReal, relative(workspaceRoot, unresolvedAbsolutePath))
    : unresolvedAbsolutePath;
  if (!isInside(rootReal, absolutePath)) return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, reason: "path_escape" };
  const workspaceRelativePath = relative(rootReal, absolutePath);
  if (looksSensitiveWorkspacePath(workspaceRelativePath)) {
    return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, reason: "sensitive_path_blocked" };
  }
  if (input.rejectProtectedProjectLedgerPaths || input.rejectProtectedProjectLedgerWrites) {
    const protectedPath = projectLedgerProtectedPath({
      workspaceRoot: rootReal,
      absolutePath,
      explicitProjectLedgerRoots: input.protectedProjectLedgerRoots,
    });
    if (protectedPath.protected) {
      return {
        ok: false,
        workspaceRoot: rootReal,
        requestedPath,
        absolutePath,
        reason: protectedPath.code,
        code: protectedPath.code,
        message: protectedPath.message,
        next: protectedPath.next,
      };
    }
  }

  try {
    const real = await realpath(absolutePath);
    if (!isInside(rootReal, real)) return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, realPath: real, reason: "symlink_escape" };
    const st = await lstat(absolutePath);
    if (st.isDirectory() && !input.allowDirectories) return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, realPath: real, reason: "directory_not_allowed" };
    if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, realPath: real, reason: "special_file_not_allowed" };
    return { ok: true, workspaceRoot: rootReal, requestedPath, absolutePath, realPath: real };
  } catch {
    if (!input.allowMissingLeaf) return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, reason: "not_found" };
    let parent = dirname(absolutePath);
    while (isInside(rootReal, parent)) {
      const parentReal = await realpath(parent).catch(() => undefined);
      if (parentReal) {
        if (!isInside(rootReal, parentReal)) return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, realPath: parentReal, reason: "parent_escape" };
        const real = resolve(parentReal, relative(parent, absolutePath));
        return { ok: true, workspaceRoot: rootReal, requestedPath, absolutePath, realPath: real };
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return { ok: false, workspaceRoot: rootReal, requestedPath, absolutePath, reason: "parent_not_found" };
  }
}
