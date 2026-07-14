import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { cognitionMemoryRoot } from "../paths.ts";
import { resolveCanonicalProjectWorkspace } from "./project-workspace.ts";

const DEFAULT_MAX_BYTES = 20 * 1024;
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;
const SEMANTIC_BLOCK = /<!-- butler-semantic:([^:>]+):start -->[\s\S]*?<!-- butler-semantic:\1:end -->\n?/gu;

export interface HotCacheWriteReceipt {
  schema_version: "butler.hot-cache-write-receipt.v1";
  source_id: string;
  scope: "project" | "global";
  project_id: string | null;
  path: string;
  replayed: boolean;
  compacted: boolean;
  bytes: number;
}

export function semanticHotCachePath(input: {
  butlerData: string;
  scope: "project" | "global";
  projectId?: string | null;
  boundWorkspacePath?: string | null;
}): string {
  if (input.scope === "global") return join(cognitionMemoryRoot(input.butlerData), "hot", "cache.md");
  if (!input.projectId?.trim()) throw new Error("hot_cache_project_binding_missing");
  const workspace = resolveCanonicalProjectWorkspace({
    butlerData: input.butlerData,
    projectId: input.projectId,
    boundWorkspacePath: input.boundWorkspacePath,
  });
  return join(workspace, ".butler", "hot-cache.md");
}

export function writeSemanticHotCacheEntry(input: {
  butlerData: string;
  scope: "project" | "global";
  projectId?: string | null;
  boundWorkspacePath?: string | null;
  sessionId: string;
  sourceId: string;
  body: string;
  createdAt?: string;
  maxBytes?: number;
  lockStaleAfterMs?: number;
}): HotCacheWriteReceipt {
  const body = input.body.trim();
  if (!body) throw new Error("hot_cache_entry_empty");
  if (body.length > 8_000) throw new Error("hot_cache_entry_too_large");
  if (containsSecret(body)) throw new Error("hot_cache_secret_rejected");
  const path = semanticHotCachePath(input);
  const safeSourceId = safeMarkerId(input.sourceId);
  const marker = `<!-- butler-semantic:${safeSourceId}:start -->`;
  let replayed = false;
  let compacted = false;
  withHotCacheLock(path, input.lockStaleAfterMs, () => {
    const current = readText(path);
    if (current.includes(marker)) {
      replayed = true;
      return;
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const block = [
      marker,
      `## [${createdAt}] ${input.projectId?.trim() || "global"} | ${input.sessionId}`,
      `- source_id: ${input.sourceId}`,
      `- scope: ${input.scope}`,
      input.projectId?.trim() ? `- project_id: ${input.projectId.trim()}` : "",
      "",
      body,
      `<!-- butler-semantic:${safeSourceId}:end -->`,
    ].filter(Boolean).join("\n");
    const appended = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
    const bounded = compactHotCache(appended, input.maxBytes ?? DEFAULT_MAX_BYTES);
    compacted = bounded !== appended;
    writeAtomicUnlocked(path, bounded);
  });
  ensureProjectGitignore(path);
  const bytes = existsSync(path) ? statSync(path).size : 0;
  recordOperationalMetric({
    category: "memory",
    name: "semantic_hot_cache_write",
    status: "ok",
    value: bytes,
    unit: "bytes",
    dimensions: {
      scope: input.scope,
      projectId: input.projectId ?? null,
      replayed,
      compacted,
    },
  }, { butlerData: input.butlerData });
  return {
    schema_version: "butler.hot-cache-write-receipt.v1",
    source_id: input.sourceId,
    scope: input.scope,
    project_id: input.projectId?.trim() || null,
    path,
    replayed,
    compacted,
    bytes,
  };
}

export function replaceManagedHotCacheSection(input: {
  butlerData: string;
  path: string;
  startMarker: string;
  endMarker: string;
  content: string;
  maxBytes?: number;
  lockStaleAfterMs?: number;
}): void {
  withHotCacheLock(input.path, input.lockStaleAfterMs, () => {
    const current = readText(input.path);
    const start = current.indexOf(input.startMarker);
    const end = current.indexOf(input.endMarker);
    const next = start >= 0 && end >= start
      ? `${current.slice(0, start)}${input.content}${current.slice(end + input.endMarker.length)}`
      : `${input.content}\n${current ? `\n${current.trim()}\n` : ""}`;
    writeAtomicUnlocked(input.path, compactHotCache(next.trimEnd() + "\n", input.maxBytes ?? DEFAULT_MAX_BYTES));
  });
  ensureProjectGitignore(input.path);
}

function withHotCacheLock(path: string, staleAfterMs = DEFAULT_LOCK_STALE_MS, fn: () => void): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  acquireLock(lock, staleAfterMs);
  try {
    fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function acquireLock(lock: string, staleAfterMs: number): void {
  try {
    writeFileSync(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleAfterMs) {
        rmSync(lock, { force: true });
        writeFileSync(lock, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return;
      }
    } catch {
      // Another writer may have replaced the lock while it was inspected.
    }
    throw new Error("hot_cache_destination_locked");
  }
}

function compactHotCache(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  const blocks = [...body.matchAll(SEMANTIC_BLOCK)].map((match) => match[0]);
  let compacted = body;
  for (const block of blocks) {
    if (Buffer.byteLength(compacted, "utf8") <= maxBytes) break;
    compacted = compacted.replace(block, "");
  }
  if (Buffer.byteLength(compacted, "utf8") <= maxBytes) return compacted.trimStart();
  const markerIndex = compacted.indexOf("<!-- butler-continuity:start -->");
  const markerEnd = compacted.indexOf("<!-- butler-continuity:end -->");
  const managed = markerIndex >= 0 && markerEnd >= markerIndex
    ? compacted.slice(markerIndex, markerEnd + "<!-- butler-continuity:end -->".length)
    : "";
  const remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(managed, "utf8") - 2);
  const tail = Buffer.from(compacted.replace(managed, ""), "utf8").subarray(-remainingBytes).toString("utf8");
  return `${managed}${managed && tail ? "\n\n" : ""}${tail}`.trimStart();
}

function writeAtomicUnlocked(path: string, body: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function ensureProjectGitignore(path: string): void {
  if (basename(dirname(path)) !== ".butler") return;
  const gitignore = join(dirname(path), ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n", { encoding: "utf8", mode: 0o600 });
}

function containsSecret(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(value) ||
    /\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}/iu.test(value);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeMarkerId(value: string): string {
  const compact = value.trim().replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
  return compact || createHash("sha256").update(value).digest("hex").slice(0, 32);
}
