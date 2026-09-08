import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AgentConversationStore } from "../../../conversation/store.ts";
import { listFeedbackEntries } from "../../feedback/buffer.ts";
import { listBoxManifests } from "../../box/store.ts";
import { TaskStore } from "../../../work/task-store.ts";
import { cognitionBoxRoot, cognitionMemoryRoot } from "../../paths.ts";
import type { MemoryExecutionContext } from "./contracts.ts";
import { ensureV2MemorySchema } from "./store.ts";
import {
  acquireConsolidationLock,
  consolidationLockPath,
  releaseConsolidationLock,
} from "../scripts/lib/lock.ts";

export type ActiveMemoryGeneration = {
  schema: "butler.memory-active-generation.v2";
  generation_id: string;
  previous_generation_id: string | null;
  activated_at: string;
  projection_mode: "running" | "paused";
};

export type MemoryGenerationHandle = {
  generationId: string;
  graphPath: string;
  root: string;
};

export function activeMemoryDescriptorPath(butlerData: string): string {
  return join(cognitionMemoryRoot(butlerData), "active-generation.json");
}

export function resolveMemoryGeneration(
  context: MemoryExecutionContext,
): MemoryGenerationHandle {
  const generationId =
    context.target.kind === "active"
      ? readActiveDescriptor(context.butlerData).generation_id
      : context.target.generation_id;
  if (
    context.target.kind === "active" &&
    generationId !== context.target.expected_generation
  ) {
    throw new Error("memory_generation_changed");
  }
  const root = join(
    cognitionMemoryRoot(context.butlerData),
    "generations",
    safeGenerationId(generationId),
  );
  const manifest = readJson(join(root, "manifest.json")) as Record<
    string,
    unknown
  >;
  if (
    manifest.schema !== "butler.memory-generation.v2" ||
    manifest.format !== "v2" ||
    manifest.generation_id !== generationId
  ) {
    throw new Error("memory_generation_version_unsupported");
  }
  return { generationId, root, graphPath: join(root, "graph.sqlite") };
}

export function readActiveDescriptor(
  butlerData: string,
): ActiveMemoryGeneration {
  const value = readJson(
    activeMemoryDescriptorPath(butlerData),
  ) as ActiveMemoryGeneration;
  if (
    value.schema !== "butler.memory-active-generation.v2" ||
    !value.generation_id
  ) {
    throw new Error("memory_generation_unavailable");
  }
  return value;
}

export function initializeEmptyMemoryGeneration(
  butlerData: string,
): ActiveMemoryGeneration {
  const lockPath = consolidationLockPath(butlerData);
  const lease = acquireConsolidationLock(lockPath, {
    purpose: "memory_initialize_empty",
  });
  if (!lease) throw new Error("memory_write_busy");
  try {
    return initializeEmptyMemoryGenerationLocked(butlerData);
  } finally {
    releaseConsolidationLock(lockPath, lease);
  }
}

function initializeEmptyMemoryGenerationLocked(
  butlerData: string,
): ActiveMemoryGeneration {
  assertTrulyEmpty(butlerData);
  const memoryRoot = cognitionMemoryRoot(butlerData);
  const generationId = randomUUID();
  const root = join(memoryRoot, "generations", generationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "graph.sqlite"), { create: true });
  try {
    ensureV2MemorySchema(db);
  } finally {
    db.close();
  }
  const now = new Date().toISOString();
  const manifest = {
    schema: "butler.memory-generation.v2",
    generation_id: generationId,
    format: "v2",
    state: "active",
    initialization_origin: "empty",
    schema_version: 2,
    extraction_version: "memory-extract-v2",
    ranking_version: 2,
    embedding: null,
    unicode_version: requiredRuntimeVersion("unicode"),
    icu_version: requiredRuntimeVersion("icu"),
    canonical_snapshot_id: "empty",
    source_inventory_hash: createHash("sha256")
      .update(JSON.stringify(["memory-source-inventory"]))
      .digest("hex"),
    registered_source_count: 0,
    unaccounted_source_count: 0,
    required_acceptance_passed: false,
  };
  writeJsonDurable(join(root, "manifest.json"), manifest);
  const descriptor: ActiveMemoryGeneration = {
    schema: "butler.memory-active-generation.v2",
    generation_id: generationId,
    previous_generation_id: null,
    activated_at: now,
    projection_mode: "running",
  };
  writeJsonDurable(activeMemoryDescriptorPath(butlerData), descriptor);
  return descriptor;
}

function assertTrulyEmpty(butlerData: string): void {
  const memoryRoot = cognitionMemoryRoot(butlerData);
  if (existsSync(activeMemoryDescriptorPath(butlerData)))
    throw new Error("memory_initialization_requires_rebuild");
  if (directoryHasEntries(join(memoryRoot, "generations")))
    throw new Error("memory_initialization_requires_rebuild");
  const store = new AgentConversationStore({ butlerData });
  try {
    if (store.countSourceBearingMessages() > 0)
      throw new Error("memory_initialization_requires_rebuild");
  } finally {
    store.close();
  }
  if (
    new TaskStore(butlerData).taskIds().length > 0 ||
    listFeedbackEntries(butlerData).length > 0 ||
    listBoxManifests(butlerData).length > 0
  ) {
    throw new Error("memory_initialization_requires_rebuild");
  }
  if (
    directoryHasSourceFiles(join(butlerData, "tasks")) ||
    directoryHasSourceFiles(cognitionBoxRoot(butlerData))
  ) {
    throw new Error("memory_initialization_requires_rebuild");
  }
  const rules = join(memoryRoot, "rules");
  if (directoryHasSourceFiles(rules)) {
    throw new Error("memory_initialization_requires_rebuild");
  }
  for (const path of [
    join(memoryRoot, "db", "graph.sqlite"),
    join(memoryRoot, "metadata.sqlite"),
  ]) {
    if (sqliteHasRows(path))
      throw new Error("memory_initialization_requires_rebuild");
  }
  for (const path of [
    join(memoryRoot, "db", "butler.lance"),
    join(memoryRoot, "hot"),
  ]) {
    if (directoryHasEntries(path))
      throw new Error("memory_initialization_requires_rebuild");
  }
}

function sqliteHasRows(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    const metadataTables = new Set([
      "memory_state",
      "schema_migrations",
      "migrations",
    ]);
    const contentTables = [
      "memory_chunks",
      "memory_chunk_sources",
      "entities",
      "edges",
      "entity_mentions",
      "memory_projection_jobs",
      "memory_projection_windows",
    ];
    const existing = new Set(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map(({ name }) => name),
    );
    if (
      contentTables.some(
        (name) =>
          existing.has(name) &&
          Number(
            db
              .query<
                { count: number },
                []
              >(`SELECT COUNT(*) count FROM "${name}"`)
              .get()?.count ?? 0,
          ) > 0,
      )
    )
      return true;
    return [...existing].some((name) => {
      if (metadataTables.has(name)) return false;
      const safeName = name.replaceAll('"', '""');
      return (
        Number(
          db
            .query<
              { count: number },
              []
            >(`SELECT COUNT(*) count FROM "${safeName}"`)
            .get()?.count ?? 0,
        ) > 0
      );
    });
  } finally {
    db.close();
  }
}

function directoryHasSourceFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size > 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && directoryHasSourceFiles(child)) return true;
      if (entry.isFile() && statSync(child).size > 0) return true;
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error("memory_initialization_source_unreadable");
      }
    }
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "memory_initialization_source_unreadable"
    ) {
      throw error;
    }
    throw new Error("memory_initialization_source_unreadable", { cause: error });
  }
}

function directoryHasEntries(path: string): boolean {
  if (!existsSync(path)) return false;
  if (!statSync(path).isDirectory())
    throw new Error("memory_initialization_source_unreadable");
  return readdirSync(path).length > 0;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("memory_generation_unavailable");
  }
}

function writeJsonDurable(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const file = openSync(temp, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

function safeGenerationId(value: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(value))
    throw new Error("memory_generation_version_unsupported");
  return value;
}

function requiredRuntimeVersion(name: "unicode" | "icu"): string {
  const value = process.versions[name];
  if (!value) throw new Error(`memory_${name}_version_unavailable`);
  return value;
}
