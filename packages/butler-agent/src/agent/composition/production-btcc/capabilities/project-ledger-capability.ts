import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CapabilityExecutionContext } from "./contracts.ts";

type LedgerRecord = {
  id: string;
  kind: string;
  title?: string;
  status?: string;
  path?: string;
  [key: string]: unknown;
};

type LedgerIndex = {
  project?: { id?: string; name?: string };
  records?: LedgerRecord[];
  issues?: unknown[];
};

export async function readProjectLedger(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  const projectId = projectIdFromScope(context.observationScopeRef);
  const projectRoot = resolve(
    context.butlerData,
    "project-ledger",
    "projects",
    projectId,
  );
  assertContained(resolve(context.butlerData, "project-ledger", "projects"), projectRoot);
  const indexPath = resolve(projectRoot, "index", "project.json");
  if (!existsSync(indexPath)) {
    return { projectId, available: false, records: [] };
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as LedgerIndex;
  const selected = selectRecords(index.records ?? [], args);
  const includeBody = args.include_body === true;
  return {
    projectId,
    available: true,
    project: index.project ?? null,
    issues: Array.isArray(index.issues) ? index.issues.length : 0,
    records: selected.map((record) => ({
      id: record.id,
      kind: record.kind,
      title: record.title ?? "",
      status: record.status ?? "",
      spec: record.spec ?? null,
      parentId: record.parentId ?? null,
      ...(includeBody ? { body: readRecordBody(record, projectRoot, context.butlerData) } : {}),
    })),
  };
}

function projectIdFromScope(scopeRef: string | undefined): string {
  if (!scopeRef?.startsWith("ledger:")) {
    throw new Error("Project Ledger capability requires an admitted ledger scope");
  }
  const projectId = scopeRef.slice("ledger:".length);
  if (!/^[A-Za-z0-9._-]+$/u.test(projectId)) {
    throw new Error("Project Ledger scope contains an invalid project id");
  }
  return projectId;
}

function selectRecords(records: LedgerRecord[], args: Record<string, unknown>): LedgerRecord[] {
  const ids = stringSet(args.record_ids, "record_ids");
  const kinds = stringSet(args.kinds, "kinds");
  const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
  const limit = Number.isInteger(args.max_records) ? Number(args.max_records) : 20;
  return records
    .filter((record) => ids.size === 0 || ids.has(record.id))
    .filter((record) => kinds.size === 0 || kinds.has(record.kind))
    .filter((record) => !query || searchableText(record).includes(query))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limit);
}

function readRecordBody(
  record: LedgerRecord,
  projectRoot: string,
  butlerData: string,
): string | null {
  if (typeof record.path !== "string" || !record.path) return null;
  const candidates = [resolve(butlerData, record.path), resolve(projectRoot, record.path)];
  const path = candidates.find((candidate) => {
    assertContained(butlerData, candidate);
    return existsSync(candidate);
  });
  return path ? readFileSync(path, "utf8") : null;
}

function stringSet(value: unknown, label: string): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return new Set(value as string[]);
}

function searchableText(record: LedgerRecord): string {
  return [record.id, record.kind, record.title, record.status]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
}

function assertContained(root: string, candidate: string): void {
  const child = relative(resolve(root), resolve(candidate));
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))) {
    return;
  }
  throw new Error("Project Ledger path escapes the configured Butler data root");
}
