import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { contentRef } from "../../core/index.ts";
import { ContentBlobStore } from "./content-blob-store.ts";
import type {
  MaterializedSnapshot,
  SnapshotEntry,
  TargetKind,
} from "./contracts.ts";
import {
  removeInventoryPayload,
  sourceInventory,
} from "./source-inventory.ts";

export class ArtifactSnapshotRepository {
  private readonly blobs: ContentBlobStore;

  constructor(database: Database, blobRoot: string) {
    this.blobs = new ContentBlobStore(blobRoot);
    database.exec(`
      CREATE TABLE IF NOT EXISTS btcc_artifact_snapshot_manifests (
        snapshot_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL
      );
    `);
    this.database = database;
  }

  private readonly database: Database;

  captureTarget(targetPath: string): MaterializedSnapshot {
    if (!existsSync(targetPath)) {
      return this.persist(snapshot("directory", [], "absent"));
    }
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error("BTCC artifact target must not be a symlink");
    }
    if (stat.isFile()) {
      return this.persist(snapshot("file", [this.fileEntry(targetPath, ".")]));
    }
    if (!stat.isDirectory()) {
      throw new Error("BTCC artifact target must be a file or directory");
    }
    return this.persist(snapshot("directory", this.captureDirectory(targetPath)));
  }

  captureWorkspace(
    workspaceRoot: string,
    targetKind: TargetKind,
    emptyTargetState: "present" | "absent" = "present",
  ): MaterializedSnapshot {
    const contentRoot = workspaceContentRoot(workspaceRoot);
    if (targetKind === "file") {
      const target = join(contentRoot, "target");
      if (!existsSync(target)) {
        return this.persist(snapshot("file", [], emptyTargetState));
      }
      return this.persist(snapshot("file", [this.fileEntry(target, ".")]));
    }
    const entries = this.captureDirectory(contentRoot);
    return this.persist(
      entries.length === 0
        ? snapshot("directory", [], emptyTargetState)
        : snapshot("directory", entries),
    );
  }

  load(snapshotId: string): MaterializedSnapshot | null {
    const row = this.database
      .query<{ manifest_json: string }, [string]>(
        `SELECT manifest_json FROM btcc_artifact_snapshot_manifests
         WHERE snapshot_id = ?`,
      )
      .get(snapshotId);
    return row ? (JSON.parse(row.manifest_json) as MaterializedSnapshot) : null;
  }

  materialize(
    snapshotValue: MaterializedSnapshot,
    root: string,
    options: { replacePayload?: boolean } = {},
  ): void {
    mkdirSync(root, { recursive: true });
    if (options.replacePayload) removeInventoryPayload(root);
    for (const entry of snapshotValue.entries) {
      const target = snapshotEntryPath(root, snapshotValue.targetKind, entry.path);
      if (entry.kind === "directory") {
        mkdirSync(target, { recursive: true });
        chmodSync(target, entry.mode);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      if (entry.kind === "symlink") {
        symlinkSync(entry.linkTarget, target);
      } else {
        this.blobs.materialize(entry.contentSha256, target);
        chmodSync(target, entry.mode);
      }
    }
  }

  materializeCompleteTarget(
    snapshotValue: MaterializedSnapshot,
    targetPath: string,
  ): void {
    if (snapshotValue.targetState === "absent") {
      throw new Error("BTCC cannot materialize an absent candidate target");
    }
    if (snapshotValue.targetKind === "directory") {
      mkdirSync(targetPath, { recursive: true });
      this.materialize(snapshotValue, targetPath);
      return;
    }
    const entry = snapshotValue.entries[0];
    if (!entry || entry.kind !== "file") {
      throw new Error("BTCC complete file snapshot is not materializable");
    }
    this.blobs.materialize(entry.contentSha256, targetPath);
    chmodSync(targetPath, entry.mode);
  }

  contentSha256ForTarget(
    snapshotValue: MaterializedSnapshot,
    relativeTarget: string,
  ): string {
    const path = snapshotValue.targetKind === "file" ? "." : relativeTarget;
    const entry = snapshotValue.entries.find((candidate) => candidate.path === path);
    return entry?.kind === "file" ? entry.contentSha256 : snapshotValue.ref.sha256;
  }

  private captureDirectory(root: string): SnapshotEntry[] {
    return sourceInventory(root).map((relativePath) => {
      const absolute = join(root, ...relativePath.split("/"));
      const stat = lstatSync(absolute);
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) return { path: relativePath, kind: "directory", mode };
      if (stat.isFile()) return this.fileEntry(absolute, relativePath);
      if (stat.isSymbolicLink()) {
        return {
          path: relativePath,
          kind: "symlink",
          mode,
          linkTarget: readlinkSync(absolute),
        };
      }
      throw new Error(`BTCC artifact snapshot rejects special node: ${relativePath}`);
    });
  }

  private fileEntry(path: string, relativePath: string): SnapshotEntry {
    const stat = lstatSync(path);
    return {
      path: relativePath,
      kind: "file",
      mode: stat.mode & 0o777,
      ...this.blobs.captureFile(path),
    };
  }

  private persist(snapshotValue: MaterializedSnapshot): MaterializedSnapshot {
    const manifest = JSON.stringify(snapshotValue);
    this.database
      .query(
        `INSERT INTO btcc_artifact_snapshot_manifests(snapshot_id, manifest_json)
         VALUES (?, ?) ON CONFLICT(snapshot_id) DO NOTHING`,
      )
      .run(snapshotValue.ref.id, manifest);
    const accepted = this.load(snapshotValue.ref.id);
    if (!accepted || JSON.stringify(accepted) !== manifest) {
      throw new Error("BTCC snapshot identity conflicts with its manifest");
    }
    return accepted;
  }
}

export function workspaceContentRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "content");
}

export function resolveWorkspaceTarget(input: {
  workspaceRoot: string;
  targetKind: TargetKind;
  relativeTarget: string;
}): string {
  const logicalTarget = input.targetKind === "file"
    ? resolveFileTarget(input.relativeTarget)
    : input.relativeTarget;
  if (isAbsolute(logicalTarget)) throw new Error("BTCC artifact target must be relative");
  const contentRoot = workspaceContentRoot(input.workspaceRoot);
  const candidate = resolve(contentRoot, logicalTarget);
  assertContained(contentRoot, candidate);
  assertNoSymlinkTraversal(contentRoot, candidate);
  return candidate;
}

function snapshot(
  targetKind: TargetKind,
  entries: SnapshotEntry[],
  targetState: "present" | "absent" = "present",
): MaterializedSnapshot {
  const body = { targetState, targetKind, entries };
  return {
    ref: contentRef("materializable-target-snapshot", body),
    ...body,
  };
}

function snapshotEntryPath(root: string, targetKind: TargetKind, path: string): string {
  if (targetKind === "file") return join(root, "target");
  const target = resolve(root, ...path.split("/"));
  assertContained(root, target);
  return target;
}

function resolveFileTarget(relativeTarget: string): string {
  const parts = relativeTarget.split(/[\\/]+/u);
  if (!relativeTarget || isAbsolute(relativeTarget) || parts.includes("..")) {
    throw new Error("BTCC file workspace target label must be contained");
  }
  return "target";
}

function assertContained(root: string, candidate: string): void {
  const child = relative(resolve(root), candidate);
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) {
    return;
  }
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
