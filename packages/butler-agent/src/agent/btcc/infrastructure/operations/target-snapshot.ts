import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { contentRef, type ContentRef } from "../../core/index.ts";

export type TargetKind = "file" | "directory";

export type SnapshotEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; bytesBase64: string; contentSha256: string }
  | { path: string; kind: "symlink"; mode: number; linkTarget: string };

export type MaterializedSnapshot = {
  ref: ContentRef;
  targetState: "present" | "absent";
  targetKind: TargetKind;
  entries: SnapshotEntry[];
};

export function captureTargetSnapshot(targetPath: string): MaterializedSnapshot {
  if (!existsSync(targetPath)) return snapshot("directory", [], "absent");
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) throw new Error("BTCC artifact target must not be a symlink");
  if (stat.isFile()) return snapshot("file", [fileEntry(targetPath, ".")]);
  if (!stat.isDirectory()) throw new Error("BTCC artifact target must be a file or directory");
  return snapshot("directory", captureDirectory(targetPath));
}

export function captureWorkspaceSnapshot(
  workspaceRoot: string,
  targetKind: TargetKind,
  emptyTargetState: "present" | "absent" = "present",
): MaterializedSnapshot {
  const contentRoot = workspaceContentRoot(workspaceRoot);
  if (targetKind === "file") {
    if (!existsSync(join(contentRoot, "target"))) return snapshot("file", [], emptyTargetState);
    return snapshot("file", [fileEntry(join(contentRoot, "target"), ".")]);
  }
  const entries = captureDirectory(contentRoot);
  return entries.length === 0
    ? snapshot("directory", [], emptyTargetState)
    : snapshot("directory", entries);
}

export function materializeSnapshot(
  snapshotValue: MaterializedSnapshot,
  root: string,
): void {
  mkdirSync(root, { recursive: true });
  for (const entry of snapshotValue.entries) {
    const target = snapshotEntryPath(root, snapshotValue.targetKind, entry.path);
    if (entry.kind === "directory") {
      mkdirSync(target, { recursive: true });
      chmodSync(target, entry.mode);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (entry.kind === "symlink") symlinkSync(entry.linkTarget, target);
    else {
      writeFileSync(target, Buffer.from(entry.bytesBase64, "base64"));
      chmodSync(target, entry.mode);
    }
  }
}

export function materializeCompleteTarget(
  snapshotValue: MaterializedSnapshot,
  targetPath: string,
): void {
  if (snapshotValue.targetState === "absent") {
    throw new Error("BTCC cannot materialize an absent candidate target");
  }
  if (snapshotValue.targetKind === "directory") {
    mkdirSync(targetPath, { recursive: true });
    materializeSnapshot(snapshotValue, targetPath);
    return;
  }
  const entry = snapshotValue.entries[0];
  if (!entry || entry.kind !== "file") {
    throw new Error("BTCC complete file snapshot is not materializable");
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, Buffer.from(entry.bytesBase64, "base64"));
  chmodSync(targetPath, entry.mode);
}

export function syncCompleteTarget(targetPath: string): void {
  const stat = lstatSync(targetPath);
  if (stat.isDirectory()) {
    for (const name of readdirSync(targetPath)) syncCompleteTarget(join(targetPath, name));
  }
  if (!stat.isSymbolicLink()) {
    const descriptor = openSync(targetPath, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

export function resolveWorkspaceTarget(input: {
  workspaceRoot: string;
  targetKind: TargetKind;
  originalTargetPath: string;
  relativeTarget: string;
}): string {
  const logicalTarget = input.targetKind === "file"
    ? resolveFileTarget(input.relativeTarget, input.originalTargetPath)
    : input.relativeTarget;
  if (isAbsolute(logicalTarget)) throw new Error("BTCC artifact target must be relative");
  const contentRoot = workspaceContentRoot(input.workspaceRoot);
  const candidate = resolve(contentRoot, logicalTarget);
  assertContained(contentRoot, candidate);
  assertNoSymlinkTraversal(contentRoot, candidate);
  return candidate;
}

export function workspaceContentRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "content");
}

export function snapshotSha256(snapshotValue: MaterializedSnapshot): string {
  return snapshotValue.ref.sha256;
}

export function bytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function removeOwnedRoot(root: string): void {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

function captureDirectory(root: string, excluded = new Set<string>()): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  visit(root, "", entries, excluded);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function visit(
  root: string,
  parent: string,
  entries: SnapshotEntry[],
  excluded: Set<string>,
): void {
  for (const name of readdirSync(join(root, parent))) {
    const child = parent ? join(parent, name) : name;
    if (excluded.has(child)) continue;
    const absolute = join(root, child);
    const stat = lstatSync(absolute);
    const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      entries.push({ path: child, kind: "directory", mode });
      visit(root, child, entries, excluded);
    } else if (stat.isFile()) entries.push(fileEntry(absolute, child));
    else if (stat.isSymbolicLink()) {
      entries.push({ path: child, kind: "symlink", mode, linkTarget: readlinkSync(absolute) });
    } else throw new Error(`BTCC artifact snapshot rejects special node: ${child}`);
  }
}

function fileEntry(path: string, relativePath: string): SnapshotEntry {
  const stat = lstatSync(path);
  const bytes = readFileSync(path);
  return {
    path: relativePath,
    kind: "file",
    mode: stat.mode & 0o777,
    bytesBase64: bytes.toString("base64"),
    contentSha256: bytesSha256(bytes),
  };
}

function snapshot(
  targetKind: TargetKind,
  entries: SnapshotEntry[],
  targetState: "present" | "absent" = "present",
): MaterializedSnapshot {
  const identityEntries = entries.map((entry) => entry.kind === "file"
    ? {
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        contentSha256: entry.contentSha256,
      }
    : entry);
  const body = { targetState, targetKind, entries: identityEntries };
  return {
    ref: contentRef("materializable-target-snapshot", body),
    targetState,
    targetKind,
    entries,
  };
}

function snapshotEntryPath(root: string, targetKind: TargetKind, path: string): string {
  if (targetKind === "file") return join(root, "target");
  const target = resolve(root, path);
  assertContained(root, target);
  return target;
}

function resolveFileTarget(relativeTarget: string, originalTargetPath: string): string {
  if (relativeTarget === "." || relativeTarget === basename(originalTargetPath)) return "target";
  throw new Error("BTCC file workspace action must address the exact target file");
}

function assertContained(root: string, candidate: string): void {
  const child = relative(resolve(root), candidate);
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) return;
  throw new Error("BTCC artifact path escapes its owned workspace");
}

function assertNoSymlinkTraversal(root: string, candidate: string): void {
  const child = relative(resolve(root), candidate);
  let current = resolve(root);
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("BTCC artifact path traverses a symlink");
    }
  }
}
