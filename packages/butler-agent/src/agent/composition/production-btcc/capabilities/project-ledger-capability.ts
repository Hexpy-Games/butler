import {
  readCanonicalProjectLedger,
  type CanonicalLedgerRecord,
} from "../../../adapters/index.ts";
import type { CapabilityExecutionContext } from "./contracts.ts";

export async function readProjectLedger(
  args: Record<string, unknown>,
  context: CapabilityExecutionContext,
): Promise<unknown> {
  const projectId = projectRefFromContext(context);
  if (!context.resolveProjectLedgerRoot) {
    throw new Error("Project Ledger capability has no active binding resolver");
  }
  const projectRoot = context.resolveProjectLedgerRoot(projectId);
  const ledger = await readCanonicalProjectLedger(projectRoot);
  const selected = selectRecords(semanticRecords(ledger.records, args), args);
  const includeBody = args.include_body === true;
  if (includeBody && explicitRecordIds(args).size === 0) {
    throw new Error("Project Ledger body reads require explicit record_ids; discover metadata first");
  }
  return {
    projectId,
    available: true,
    project: ledger.project,
    records: selected.map((record) => ({
      id: record.id,
      kind: record.kind,
      title: record.title ?? "",
      status: record.status ?? "",
      spec: record.spec ?? null,
      parentId: record.parentId ?? null,
      ...(includeBody ? { body: record.body } : {}),
    })),
  };
}

function semanticRecords(
  records: CanonicalLedgerRecord[],
  args: Record<string, unknown>,
): CanonicalLedgerRecord[] {
  const ids = explicitRecordIds(args);
  const kinds = stringSet(args.kinds, "kinds");
  if (kinds.has("reference")) return records;
  if (ids.size === 0) return records.filter((record) => record.kind !== "reference");
  const semanticIds = new Set(
    records
      .filter((record) => ids.has(record.id) && record.kind !== "reference")
      .map((record) => record.id),
  );
  return records.filter((record) =>
    record.kind !== "reference" || !semanticIds.has(record.id));
}

function projectRefFromContext(context: CapabilityExecutionContext): string {
  if (context.observationScopeRef?.startsWith("ledger:")) {
    const projectRef = context.observationScopeRef.slice("ledger:".length);
    if (projectRef) return projectRef;
  }
  if (context.projectRef) return context.projectRef;
  throw new Error("Project Ledger capability requires an admitted project binding");
}

function selectRecords(
  records: CanonicalLedgerRecord[],
  args: Record<string, unknown>,
): CanonicalLedgerRecord[] {
  const ids = explicitRecordIds(args);
  const kinds = stringSet(args.kinds, "kinds");
  const queryTerms = typeof args.query === "string"
    ? args.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    : [];
  const limit = Number.isInteger(args.max_records) ? Number(args.max_records) : 20;
  return records
    .filter((record) => ids.size === 0 || ids.has(record.id))
    .filter((record) => kinds.size === 0 || kinds.has(record.kind))
    .filter((record) => queryTerms.length === 0 ||
      queryTerms.some((term) => searchableText(record).includes(term)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limit);
}

function explicitRecordIds(args: Record<string, unknown>): Set<string> {
  return stringSet(args.record_ids, "record_ids");
}

function stringSet(value: unknown, label: string): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return new Set(value as string[]);
}

function searchableText(record: CanonicalLedgerRecord): string {
  return [record.id, record.kind, record.title, record.status, record.body]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLocaleLowerCase();
}
