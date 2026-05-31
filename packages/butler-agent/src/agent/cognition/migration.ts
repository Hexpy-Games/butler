import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { cognitionMemoryRoot, cognitionMigrationRoot, cognitionRoot } from "./paths.ts";

export const COGNITION_NAMESPACE_MIGRATION_SCHEMA = "butler.cognition.namespace-migration.v1";

export interface CognitionNamespaceMigrationPlan {
  schema: typeof COGNITION_NAMESPACE_MIGRATION_SCHEMA;
  status: "ready" | "applied" | "not_needed" | "conflict";
  legacy_memory_root: string;
  cognition_root: string;
  cognition_memory_root: string;
  migration_root: string;
  manifest_path: string;
  legacy_exists: boolean;
  cognition_memory_exists: boolean;
  legacy_file_count: number;
  legacy_byte_count: number;
  cognition_memory_file_count: number;
  cognition_memory_byte_count: number;
  conflicts: string[];
  rawTextIncluded: false;
}

export interface CognitionNamespaceMigrationManifest {
  schema: typeof COGNITION_NAMESPACE_MIGRATION_SCHEMA;
  migration_id: string;
  started_at: string;
  completed_at: string;
  legacy_memory_root: string;
  cognition_root: string;
  cognition_memory_root: string;
  backup_root: string | null;
  moved_paths: Array<{ from: string; to: string }>;
  conflicts: string[];
  status: "applied" | "conflict" | "failed";
  rawTextIncluded: false;
}

function legacyMemoryRoot(butlerData: string): string {
  return join(butlerData, "memory");
}

function manifestPath(butlerData: string): string {
  return join(cognitionMigrationRoot(butlerData), "namespace-v1.json");
}

function lockPath(butlerData: string): string {
  return join(cognitionMigrationRoot(butlerData), "namespace-v1.lock");
}

function fileStats(root: string): { fileCount: number; byteCount: number } {
  if (!existsSync(root)) return { fileCount: 0, byteCount: 0 };
  let fileCount = 0;
  let byteCount = 0;
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === ".DS_Store") continue;
        visit(join(path, entry));
      }
      return;
    }
    if (stat.isFile()) {
      fileCount += 1;
      byteCount += stat.size;
    }
  };
  visit(root);
  return { fileCount, byteCount };
}

function readManifest(path: string): CognitionNamespaceMigrationManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CognitionNamespaceMigrationManifest;
    return parsed?.schema === COGNITION_NAMESPACE_MIGRATION_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

export function buildCognitionNamespaceMigrationPlan(butlerData: string): CognitionNamespaceMigrationPlan {
  const legacyRoot = legacyMemoryRoot(butlerData);
  const cognition = cognitionRoot(butlerData);
  const memoryRoot = cognitionMemoryRoot(butlerData);
  const migrationRoot = cognitionMigrationRoot(butlerData);
  const manifest = readManifest(manifestPath(butlerData));
  const legacy = fileStats(legacyRoot);
  const target = fileStats(memoryRoot);
  const legacyExists = existsSync(legacyRoot);
  const targetExists = existsSync(memoryRoot);
  const legacyActive = legacy.fileCount > 0;
  const targetActive = target.fileCount > 0;
  const conflicts = legacyActive && targetActive && manifest?.status !== "applied"
    ? ["legacy and cognition memory roots both contain active data"]
    : [];
  const status = conflicts.length > 0
    ? "conflict"
    : manifest?.status === "applied"
      ? "applied"
      : legacyActive
        ? "ready"
        : targetActive
          ? "applied"
          : "not_needed";

  return {
    schema: COGNITION_NAMESPACE_MIGRATION_SCHEMA,
    status,
    legacy_memory_root: legacyRoot,
    cognition_root: cognition,
    cognition_memory_root: memoryRoot,
    migration_root: migrationRoot,
    manifest_path: manifestPath(butlerData),
    legacy_exists: legacyExists,
    cognition_memory_exists: targetExists,
    legacy_file_count: legacy.fileCount,
    legacy_byte_count: legacy.byteCount,
    cognition_memory_file_count: target.fileCount,
    cognition_memory_byte_count: target.byteCount,
    conflicts,
    rawTextIncluded: false,
  };
}

function acquireLock(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function moveDirectory(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  if (existsSync(to) && fileStats(to).fileCount === 0) {
    rmSync(to, { recursive: true, force: true });
  }
  try {
    renameSync(from, to);
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
    rmSync(from, { recursive: true, force: true });
  }
}

export function applyCognitionNamespaceMigration(butlerData: string): CognitionNamespaceMigrationManifest {
  const started = new Date().toISOString();
  const lock = lockPath(butlerData);
  let fd: number | null = null;
  try {
    fd = acquireLock(lock);
    const plan = buildCognitionNamespaceMigrationPlan(butlerData);
    if (plan.conflicts.length > 0) {
      const manifest: CognitionNamespaceMigrationManifest = {
        schema: COGNITION_NAMESPACE_MIGRATION_SCHEMA,
        migration_id: `namespace-v1-${Date.now()}`,
        started_at: started,
        completed_at: new Date().toISOString(),
        legacy_memory_root: plan.legacy_memory_root,
        cognition_root: plan.cognition_root,
        cognition_memory_root: plan.cognition_memory_root,
        backup_root: null,
        moved_paths: [],
        conflicts: plan.conflicts,
        status: "conflict",
        rawTextIncluded: false,
      };
      writeJson(plan.manifest_path, manifest);
      return manifest;
    }

    const movedPaths: CognitionNamespaceMigrationManifest["moved_paths"] = [];
    let backupRoot: string | null = null;
    if (plan.status === "ready") {
      backupRoot = join(plan.migration_root, "backup", `memory-${Date.now()}`);
      cpSync(plan.legacy_memory_root, backupRoot, { recursive: true, force: true, errorOnExist: false });
      moveDirectory(plan.legacy_memory_root, plan.cognition_memory_root);
      movedPaths.push({ from: plan.legacy_memory_root, to: plan.cognition_memory_root });
    } else {
      mkdirSync(plan.cognition_memory_root, { recursive: true, mode: 0o700 });
    }

    const manifest: CognitionNamespaceMigrationManifest = {
      schema: COGNITION_NAMESPACE_MIGRATION_SCHEMA,
      migration_id: `namespace-v1-${Date.now()}`,
      started_at: started,
      completed_at: new Date().toISOString(),
      legacy_memory_root: plan.legacy_memory_root,
      cognition_root: plan.cognition_root,
      cognition_memory_root: plan.cognition_memory_root,
      backup_root: backupRoot,
      moved_paths: movedPaths,
      conflicts: [],
      status: "applied",
      rawTextIncluded: false,
    };
    writeJson(plan.manifest_path, manifest);
    return manifest;
  } catch (error) {
    const plan = buildCognitionNamespaceMigrationPlan(butlerData);
    const manifest: CognitionNamespaceMigrationManifest = {
      schema: COGNITION_NAMESPACE_MIGRATION_SCHEMA,
      migration_id: `namespace-v1-${Date.now()}`,
      started_at: started,
      completed_at: new Date().toISOString(),
      legacy_memory_root: plan.legacy_memory_root,
      cognition_root: plan.cognition_root,
      cognition_memory_root: plan.cognition_memory_root,
      backup_root: null,
      moved_paths: [],
      conflicts: [error instanceof Error ? error.message : String(error)],
      status: "failed",
      rawTextIncluded: false,
    };
    writeJson(plan.manifest_path, manifest);
    return manifest;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(lock); } catch {}
  }
}
