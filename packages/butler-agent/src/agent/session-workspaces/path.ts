import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  SESSION_WORKSPACE_BINDING_SCHEMA,
  type SessionWorkspaceBindingMarker,
} from "./contracts.ts";

export const MAX_PUBLIC_LABEL_LENGTH = 80;

export function normalizeBranch(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeStartPoint(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isSafeRefInput(value: string, options: { allowHead?: boolean } = {}): boolean {
  return Boolean(value) &&
    !value.startsWith("-") &&
    !value.startsWith("refs/") &&
    !value.includes("\0") &&
    !/[\r\n]/u.test(value) &&
    (options.allowHead === true || value !== "HEAD") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("~") &&
    !value.includes("^");
}

export function publicWorkspaceLabel(branch: string): string {
  return [...`session-worktree/${branch}`].slice(0, MAX_PUBLIC_LABEL_LENGTH).join("");
}

export function deterministicTargetPath(
  butlerData: string,
  sessionId: string,
  branch: string,
  projectName?: string,
): string {
  const dataRoot = canonicalPath(butlerData);
  const root = resolve(dataRoot, "worktrees", "sessions");
  const digest = createHash("sha256")
    .update(`${sessionId}\0${branch}`)
    .digest("hex")
    .slice(0, 16);
  const name = projectName
    ? `${safeProjectLabel(projectName)}-${digest}`
    : `${safeLabel(sessionId)}-${safeLabel(branch)}-${digest}`;
  const target = resolve(root, name);
  const rel = relative(dataRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("session_worktree_target_escape");
  }
  return target;
}

export function ensureSessionWorktreeRoot(butlerData: string, targetPath: string): void {
  const dataRoot = canonicalPath(butlerData);
  const root = resolve(dataRoot, "worktrees", "sessions");
  const relativeRoot = relative(dataRoot, root);
  if (relativeRoot.startsWith("..") || isAbsolute(relativeRoot)) {
    throw new Error("session_worktree_root_escape");
  }
  const worktreesRoot = resolve(dataRoot, "worktrees");
  assertNoSymlink(worktreesRoot);
  assertNoSymlink(root);
  mkdirSync(root, { recursive: true });
  const relativeTarget = relative(canonicalPath(root), targetPath);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error("session_worktree_target_escape");
  }
}

export function pathOccupied(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() || statSync(path).isDirectory() || statSync(path).isFile();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function readSessionWorkspaceMarker(
  metadata: Record<string, unknown> | undefined,
): SessionWorkspaceBindingMarker | "invalid" | undefined {
  const raw = metadata?.sessionWorkspace;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const marker = raw as Record<string, unknown>;
  if (
    marker.schema !== SESSION_WORKSPACE_BINDING_SCHEMA ||
    marker.ownership !== "session" ||
    typeof marker.repositoryAnchorPath !== "string" ||
    !isAbsolute(marker.repositoryAnchorPath) ||
    typeof marker.branch !== "string" ||
    !marker.branch.trim() ||
    !isSafeRefInput(marker.branch.trim()) ||
    typeof marker.boundAt !== "string" ||
    !marker.boundAt.trim()
  ) return "invalid";
  return marker as unknown as SessionWorkspaceBindingMarker;
}

export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function safeLabel(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (normalized || "session").slice(0, 48);
}

function safeProjectLabel(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return [...(normalized || "project")].slice(0, 32).join("");
}

function assertNoSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("session_worktree_symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
