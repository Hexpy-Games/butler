import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ArtifactSnapshotRepository,
  copyWorkspaceControls,
} from "../../packages/butler-agent/src/agent/btcc/infrastructure/artifact-snapshot/index.ts";
import { ArtifactStore } from "../../packages/butler-agent/src/agent/btcc/infrastructure/operations/artifact-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stores bounded manifests and deduplicated blobs outside SQLite", () => {
  const root = temporaryRoot();
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "node_modules", "dependency"), { recursive: true });
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  writeFileSync(join(project, "src", "index.ts"), "export const ready = true;\n");
  writeFileSync(
    join(project, "node_modules", "dependency", "large.bin"),
    Buffer.alloc(8 * 1024 * 1024, 7),
  );
  initializeGit(project);

  const database = new Database(join(root, "snapshots.sqlite"), { create: true });
  const blobRoot = join(root, "blobs");
  const snapshots = new ArtifactSnapshotRepository(database, blobRoot);
  const first = snapshots.captureTarget(project);
  const second = snapshots.captureTarget(project);
  const manifest = database
    .query<{ manifest_json: string }, [string]>(
      `SELECT manifest_json FROM btcc_artifact_snapshot_manifests
       WHERE snapshot_id = ?`,
    )
    .get(first.ref.id)?.manifest_json ?? "";

  expect(second.ref).toEqual(first.ref);
  expect(first.entries.some((entry) => entry.path.startsWith("node_modules")))
    .toBe(false);
  expect(manifest).not.toContain("bytesBase64");
  expect(manifest.length).toBeLessThan(4_096);
  expect(database.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM btcc_artifact_snapshot_manifests",
  ).get()?.count).toBe(1);
  const sourceEntry = first.entries.find((entry) => entry.path === "src/index.ts");
  expect(sourceEntry?.kind).toBe("file");
  if (sourceEntry?.kind === "file") {
    expect(existsSync(join(blobRoot, sourceEntry.contentSha256.slice(0, 2), sourceEntry.contentSha256)))
      .toBe(true);
  }
  database.close();
});

test("restores payload while preserving repository control metadata", () => {
  const root = temporaryRoot();
  const project = join(root, "project");
  const workspace = join(root, "workspace");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "index.ts"), "original\n");
  initializeGit(project);
  const database = new Database(":memory:");
  const snapshots = new ArtifactSnapshotRepository(database, join(root, "blobs"));
  const baseline = snapshots.captureTarget(project);

  snapshots.materialize(baseline, workspace);
  copyWorkspaceControls(project, workspace);
  writeFileSync(join(workspace, "src", "index.ts"), "changed\n");
  writeFileSync(join(workspace, "new.txt"), "remove me\n");
  snapshots.materialize(baseline, workspace, { replacePayload: true });

  expect(readFileSync(join(workspace, "src", "index.ts"), "utf8")).toBe("original\n");
  expect(existsSync(join(workspace, "new.txt"))).toBe(false);
  expect(existsSync(join(workspace, ".git"))).toBe(true);
  database.close();
});

test("replaces the incompatible byte-in-JSON runtime instead of migrating it", () => {
  const root = temporaryRoot();
  const databasePath = join(root, "runtime", "btcc-artifacts.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const legacy = new Database(databasePath, { create: true });
  legacy.exec(`
    CREATE TABLE btcc_artifact_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);
  legacy.query(
    "INSERT INTO btcc_artifact_snapshots(snapshot_id, value_json) VALUES (?, ?)",
  ).run("legacy", JSON.stringify({ bytesBase64: "obsolete" }));
  legacy.close();
  mkdirSync(join(root, "runtime", "btcc-artifacts", "stale"), { recursive: true });

  new ArtifactStore(root);
  const current = new Database(databasePath, { readonly: true });
  const tables = current
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

  expect(tables).not.toContain("btcc_artifact_snapshots");
  expect(tables).toContain("btcc_artifact_snapshot_manifests");
  expect(existsSync(join(root, "runtime", "btcc-artifacts"))).toBe(false);
  current.close();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-artifact-snapshot-"));
  roots.push(root);
  return root;
}

function initializeGit(root: string): void {
  const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git init failed");
}
