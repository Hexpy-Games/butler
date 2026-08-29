import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectLedgerHead } from "./runtime-types.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";

export type CanonicalLedgerRecord = {
  id: string;
  kind: string;
  title: string;
  status: string;
  spec: string | null;
  parentId: string | null;
  body: string | null;
};

export type ExactLedgerTarget = {
  id: string;
  kind: string;
  path: string;
  parentId: string | null;
};

export type ExactLedgerTargetPrecondition = ExactLedgerTarget & (
  | { state: "absent" }
  | { state: "present"; rawRecordSha256: string }
);

export type ExactLedgerRecord = ExactLedgerTarget & {
  rawRecordSha256: string;
  body: string;
};

export type ExactLedgerReadSnapshot = {
  records: ExactLedgerRecord[];
  targetPreconditions: ExactLedgerTargetPrecondition[];
};

export type ExactLedgerSnapshot = ExactLedgerReadSnapshot & {
  expectedBase: ProjectLedgerHead;
};

type ExactReaderDependencies = {
  observeHead(projectRoot: string): Promise<ProjectLedgerHead>;
};

const DEFAULT_STABLE_READ_ATTEMPTS = 3;

export async function readCanonicalProjectLedger(projectRoot: string) {
  const core = await loadProjectLedgerCore();
  const index = core.buildIndex(projectRoot);
  const records = index.records.map((record): CanonicalLedgerRecord => {
    const sourcePath = core.projectPath(projectRoot, record.path);
    const data = core.readRecordData(sourcePath) ?? {};
    return {
      id: record.id,
      kind: record.kind,
      title: record.title,
      status: record.status,
      spec: stringValue(data.spec),
      parentId: stringValue(data.parentId),
      body: core.readRecordBody(sourcePath),
    };
  });
  return {
    project: JSON.parse(readFileSync(join(projectRoot, "project.json"), "utf8")) as unknown,
    records,
  };
}

export async function findCanonicalProjectLedgerRecordKinds(
  projectRoot: string,
  recordId: string,
): Promise<string[]> {
  const core = await loadProjectLedgerCore();
  return [...new Set(
    core.buildIndex(projectRoot).records
      .filter((record) => record.id === recordId)
      .map((record) => record.kind),
  )].sort();
}

export async function readStableExactProjectLedgerSnapshot(input: {
  projectRoot: string;
  targets: ExactLedgerTarget[];
  maxAttempts?: number;
}, dependencies: ExactReaderDependencies = { observeHead: observeProjectLedgerHead }): Promise<ExactLedgerSnapshot> {
  const attempts = boundedAttempts(input.maxAttempts);
  assertUniqueTargets(input.targets);
  const scope = canonicalScope(input.projectRoot);
  for (const target of input.targets) exactPath(scope, target.path);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const headBefore = await dependencies.observeHead(scope.root);
    assertHeadScope(headBefore, scope.root);
    const snapshot = await readExactSnapshot(scope, input.targets);
    const headAfter = await dependencies.observeHead(scope.root);
    assertHeadScope(headAfter, scope.root);
    if (sameHead(headBefore, headAfter)) {
      return { ...snapshot, expectedBase: headAfter };
    }
  }
  throw new Error("project_ledger_exact_reader_unstable_source");
}

export async function readExactProjectLedgerSnapshot(input: {
  projectRoot: string;
  targets: ExactLedgerTarget[];
}): Promise<ExactLedgerReadSnapshot> {
  assertUniqueTargets(input.targets);
  const scope = canonicalScope(input.projectRoot);
  for (const target of input.targets) exactPath(scope, target.path);
  return await readExactSnapshot(scope, input.targets);
}

export async function revalidateExactLedgerPreconditions(
  projectRoot: string,
  preconditions: ExactLedgerTargetPrecondition[],
): Promise<void> {
  assertUniqueTargets(preconditions);
  const scope = canonicalScope(projectRoot);
  const core = await loadProjectLedgerCore();
  for (const precondition of preconditions) {
    const path = exactPath(scope, precondition.path);
    if (precondition.state === "absent") {
      if (existsSync(path)) throw new Error("project_ledger_exact_absence_changed");
      continue;
    }
    if (!existsSync(path)) throw new Error("project_ledger_exact_record_missing");
    const raw = readFileSync(path);
    if (sha256(raw) !== precondition.rawRecordSha256) {
      throw new Error("project_ledger_exact_record_hash_changed");
    }
    const data = readOfficialRecordData(core, path);
    assertExactMetadata(data, precondition);
  }
}

async function readExactSnapshot(scope: CanonicalLedgerScope, targets: ExactLedgerTarget[]): Promise<{
  records: ExactLedgerRecord[];
  targetPreconditions: ExactLedgerTargetPrecondition[];
}> {
  const core = await loadProjectLedgerCore();
  const paths = targets.map((target) => exactPath(scope, target.path));
  const records: ExactLedgerRecord[] = [];
  const targetPreconditions: ExactLedgerTargetPrecondition[] = [];
  for (const [targetIndex, target] of targets.entries()) {
    const path = paths[targetIndex]!;
    if (!existsSync(path)) {
      targetPreconditions.push({ ...target, state: "absent" });
      continue;
    }
    if (!existsSync(path)) throw new Error("project_ledger_exact_record_missing");
    const raw = readFileSync(path);
    const data = readOfficialRecordData(core, path);
    assertExactMetadata(data, target);
    const bodyText = core.readRecordBody(path);
    if (bodyText === null) throw new Error("project_ledger_exact_body_corrupt");
    const rawRecordSha256 = sha256(raw);
    records.push({ ...target, rawRecordSha256, body: bodyText });
    targetPreconditions.push({ ...target, state: "present", rawRecordSha256 });
  }
  return { records, targetPreconditions };
}

type CanonicalLedgerScope = {
  root: string;
  projectId: string;
};

function canonicalScope(projectRoot: string): CanonicalLedgerScope {
  const requestedRoot = resolve(projectRoot);
  if (!existsSync(requestedRoot)) throw new Error("project_ledger_root_missing");
  if (lstatSync(requestedRoot).isSymbolicLink()) throw new Error("project_ledger_root_symlink");
  const root = realpathSync(requestedRoot);
  const projectFile = join(root, "project.json");
  assertNoSymlinkComponents(root, projectFile);
  let project: { id?: unknown };
  try {
    project = JSON.parse(readFileSync(projectFile, "utf8")) as { id?: unknown };
  } catch {
    throw new Error("project_ledger_project_identity_invalid");
  }
  const projectId = safeProjectSegment(project.id);
  if (!projectId) throw new Error("project_ledger_project_identity_invalid");
  return { root, projectId };
}

function exactPath(scope: CanonicalLedgerScope, indexedPath: string): string {
  if (!indexedPath || isAbsolute(indexedPath)) throw new Error("project_ledger_exact_path_outside_root");
  const prefix = `project-ledger/projects/${scope.projectId}/`;
  if (!indexedPath.startsWith(prefix)) throw new Error("project_ledger_exact_path_outside_root");
  const path = resolve(scope.root, indexedPath.slice(prefix.length));
  const rel = relative(scope.root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("project_ledger_exact_path_outside_root");
  }
  assertNoSymlinkComponents(scope.root, path);
  return path;
}

function assertNoSymlinkComponents(root: string, path: string): void {
  let cursor = root;
  for (const part of relative(root, path).split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, part);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new Error("project_ledger_exact_path_symlink");
  }
}

function safeProjectSegment(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

function readOfficialRecordData(
  core: Awaited<ReturnType<typeof loadProjectLedgerCore>>,
  path: string,
): Record<string, unknown> {
  const data = core.readRecordData(path);
  if (!data) throw new Error("project_ledger_exact_frontmatter_corrupt");
  return data;
}

function assertExactMetadata(data: Record<string, unknown>, target: ExactLedgerTarget): void {
  if (data.id !== target.id || data.kind !== target.kind || (data.parentId ?? null) !== target.parentId) {
    throw new Error("project_ledger_exact_record_metadata_mismatch");
  }
}

function assertUniqueTargets(targets: ExactLedgerTarget[]): void {
  const keys = new Set<string>();
  for (const target of targets) {
    const key = `${target.kind}\0${target.id}\0${target.path}`;
    if (keys.has(key)) throw new Error("project_ledger_exact_target_ambiguous");
    keys.add(key);
  }
}

function boundedAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_STABLE_READ_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("project_ledger_exact_reader_invalid_attempt_bound");
  }
  return attempts;
}

function sameHead(left: ProjectLedgerHead, right: ProjectLedgerHead): boolean {
  return left.schema === right.schema && left.projectRoot === right.projectRoot &&
    left.sourceSha256 === right.sourceSha256 && left.sourceFileCount === right.sourceFileCount &&
    left.storageSha256 === right.storageSha256 && left.storageEntryCount === right.storageEntryCount;
}

function assertHeadScope(head: ProjectLedgerHead, root: string): void {
  const requestedRoot = resolve(head.projectRoot);
  if (!existsSync(requestedRoot) || realpathSync(requestedRoot) !== root) {
    throw new Error("project_ledger_exact_head_scope_mismatch");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
