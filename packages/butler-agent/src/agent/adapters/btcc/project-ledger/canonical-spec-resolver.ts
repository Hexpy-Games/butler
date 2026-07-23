import { createHash } from "node:crypto";
import type { ProjectLedgerCore } from "./project-ledger-core.ts";

export type CanonicalSpecRevision = {
  logicalId: string;
  parentId: string;
  concernId: string;
  revisionRef: { id: string; sha256: string };
  title: string;
  status: string;
  body: string;
};

export class CanonicalSpecSupersessionCycleError extends Error {
  readonly code = "canonical_spec_supersession_cycle";

  constructor(readonly logicalId: string) {
    super(`Canonical Project Spec supersession cycle: ${logicalId}`);
    this.name = "CanonicalSpecSupersessionCycleError";
  }
}

type SpecMetadata = {
  physicalId: string;
  title: string;
  status: string;
  filePath: string;
  logicalId?: string;
  parentId: string;
  concernId?: string;
  supersedesId?: string;
};

type ValidatedSpec = SpecMetadata & {
  logicalId: string;
  parentId: string;
  concernId: string;
};

export function resolveCanonicalSpecRevisions(
  core: ProjectLedgerCore,
  projectRoot: string,
  governingLogicalIds: readonly string[],
): CanonicalSpecRevision[] {
  const requested = exactLogicalIds(governingLogicalIds);
  if (requested.length === 0) return [];
  const index = buildMetadataIndex(core, projectRoot);
  const selected = requested.map((logicalId) => resolveRequestedChain(index, logicalId));
  rejectCompetingConcernOwners(index, selected);
  return selected.map((spec) => hydrateSelectedSpec(core, spec));
}

export function resolveCanonicalSpecCatalog(
  core: ProjectLedgerCore,
  projectRoot: string,
): CanonicalSpecRevision[] {
  const index = buildMetadataIndex(core, projectRoot);
  const logicalIds = [...new Set(
    [...index.values()].map((spec) => spec.logicalId ?? spec.physicalId),
  )].filter((logicalId) => hasCurrentAuthority(index, logicalId)).sort();
  const selected = logicalIds.map((logicalId) => resolveRequestedChain(index, logicalId));
  rejectCompetingConcernOwners(index, selected);
  return selected.map((spec) => hydrateSelectedSpec(core, spec));
}

export function normalizeSpecBody(body: string): string {
  return `${body.normalize("NFC").replace(/\r\n?|\n/gu, "\n").replace(/\n+$/u, "")}\n`;
}

function buildMetadataIndex(
  core: ProjectLedgerCore,
  projectRoot: string,
): Map<string, SpecMetadata> {
  const index = new Map<string, SpecMetadata>();
  const records = core.buildIndex(projectRoot).records;
  const rootParentId = projectRootAuthority(records);
  for (const record of records) {
    if (record.kind !== "spec") continue;
    const found = core.resolveRecord(projectRoot, { kind: "spec", id: record.id });
    const data = core.readRecordData(found.filePath) ?? {};
    const supersedesId = stringField(data.supersedesSpecId) ?? stringField(data.supersedesId);
    index.set(record.id, {
      physicalId: record.id,
      title: record.title,
      status: record.status,
      filePath: found.filePath,
      ...(stringField(data.logicalId) ? { logicalId: stringField(data.logicalId) } : {}),
      parentId: stringField(data.parentId) ?? rootParentId,
      ...(stringField(data.concernId) ? { concernId: stringField(data.concernId) } : {}),
      ...(supersedesId ? { supersedesId } : {}),
    });
  }
  return index;
}

function resolveRequestedChain(
  index: Map<string, SpecMetadata>,
  requestedLogicalId: string,
): ValidatedSpec {
  const candidates = [...index.values()].filter((spec) =>
    (spec.logicalId ?? spec.physicalId) === requestedLogicalId);
  if (candidates.length === 0) {
    throw new Error(`Canonical Project Spec does not exist: ${requestedLogicalId}`);
  }
  const validated = candidates.map((spec) => validateChainMember(spec, requestedLogicalId));
  validateSupersessionGraph(index, validated, requestedLogicalId);
  const superseded = new Set(validated.flatMap((spec) =>
    spec.supersedesId ? [spec.supersedesId] : []));
  const current = validated.filter((spec) =>
    isActive(spec.status) && !superseded.has(spec.physicalId));
  if (current.length !== 1) {
    throw new Error(
      `Canonical Project Spec authority must resolve to exactly one current revision: ${requestedLogicalId}`,
    );
  }
  const authority = current[0]!;
  assertConnectedLineage(validated, authority, requestedLogicalId);
  for (const member of validated) {
    if (member.parentId !== authority.parentId || member.concernId !== authority.concernId) {
      throw new Error(`Canonical Project Spec revision lineage changed: ${requestedLogicalId}`);
    }
  }
  return authority;
}

function assertConnectedLineage(
  chain: ValidatedSpec[],
  authority: ValidatedSpec,
  logicalId: string,
): void {
  const byId = new Map(chain.map((spec) => [spec.physicalId, spec]));
  const connected = new Set<string>();
  let cursor: ValidatedSpec | undefined = authority;
  while (cursor) {
    connected.add(cursor.physicalId);
    cursor = cursor.supersedesId ? byId.get(cursor.supersedesId) : undefined;
  }
  if (connected.size !== chain.length) {
    throw new Error(`Canonical Project Spec revision lineage is disconnected: ${logicalId}`);
  }
}

function validateChainMember(spec: SpecMetadata, requestedLogicalId: string): ValidatedSpec {
  const logicalId = spec.logicalId ?? spec.physicalId;
  if (logicalId !== requestedLogicalId) {
    throw new Error(`Canonical Project Spec logicalId changed: ${spec.physicalId}`);
  }
  return {
    ...spec,
    logicalId,
    parentId: spec.parentId,
    concernId: spec.concernId ?? logicalId,
  };
}

function validateSupersessionGraph(
  index: Map<string, SpecMetadata>,
  chain: ValidatedSpec[],
  logicalId: string,
): void {
  const byId = new Map(chain.map((spec) => [spec.physicalId, spec]));
  for (const spec of chain) {
    if (!spec.supersedesId) continue;
    const target = index.get(spec.supersedesId);
    if (!target) {
      throw new Error(`Canonical Project Spec supersedes missing revision: ${spec.supersedesId}`);
    }
    if ((target.logicalId ?? target.physicalId) !== logicalId || !byId.has(target.physicalId)) {
      throw new Error(`Canonical Project Spec supersedes foreign logical authority: ${spec.physicalId}`);
    }
  }
  const colors = new Map<string, "visiting" | "visited">();
  const visit = (physicalId: string): void => {
    const color = colors.get(physicalId);
    if (color === "visiting") throw new CanonicalSpecSupersessionCycleError(logicalId);
    if (color === "visited") return;
    colors.set(physicalId, "visiting");
    const supersedesId = byId.get(physicalId)?.supersedesId;
    if (supersedesId) visit(supersedesId);
    colors.set(physicalId, "visited");
  };
  for (const spec of chain) visit(spec.physicalId);
}

function rejectCompetingConcernOwners(
  index: Map<string, SpecMetadata>,
  selected: ValidatedSpec[],
): void {
  for (const authority of selected) {
    for (const spec of index.values()) {
      const logicalId = spec.logicalId ?? spec.physicalId;
      const concernId = spec.concernId ?? logicalId;
      if (logicalId !== authority.logicalId && concernId === authority.concernId &&
        isCurrentMetadata(index, spec, logicalId)) {
        throw new Error(
          `Canonical Project Specs claim competing current authority for ${authority.concernId}`,
        );
      }
    }
  }
}

function isCurrentMetadata(
  index: Map<string, SpecMetadata>,
  spec: SpecMetadata,
  logicalId: string,
): boolean {
  if (!isActive(spec.status)) return false;
  return ![...index.values()].some((candidate) =>
    (candidate.logicalId ?? candidate.physicalId) === logicalId &&
    candidate.supersedesId === spec.physicalId && isActive(candidate.status));
}

function hasCurrentAuthority(
  index: Map<string, SpecMetadata>,
  logicalId: string,
): boolean {
  return [...index.values()].some((spec) =>
    (spec.logicalId ?? spec.physicalId) === logicalId &&
    isCurrentMetadata(index, spec, logicalId));
}

function hydrateSelectedSpec(
  core: ProjectLedgerCore,
  spec: ValidatedSpec,
): CanonicalSpecRevision {
  const source = core.readRecordBody(spec.filePath);
  if (source === null) {
    throw new Error(`Canonical Project Spec body is missing: ${spec.physicalId}`);
  }
  const body = normalizeSpecBody(source);
  return {
    logicalId: spec.logicalId,
    parentId: spec.parentId,
    concernId: spec.concernId,
    revisionRef: { id: spec.logicalId, sha256: sha256(body) },
    title: spec.title,
    status: spec.status,
    body,
  };
}

function projectRootAuthority(
  records: Array<{ id: string; kind: string }>,
): string {
  const projects = records.filter((record) => record.kind === "project");
  if (projects.length !== 1) {
    throw new Error("Canonical Project Ledger must contain exactly one project authority");
  }
  return projects[0]!.id;
}

function isActive(status: string): boolean {
  return !["cancelled", "done", "superseded"].includes(status);
}

function exactLogicalIds(values: readonly string[]): string[] {
  const logicalIds = values.map((value) => value.trim());
  if (logicalIds.some((value) => value.length === 0)) {
    throw new Error("Governing Spec logical IDs must be non-empty");
  }
  if (new Set(logicalIds).size !== logicalIds.length) {
    throw new Error("Governing Spec logical IDs must be unique");
  }
  return logicalIds;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
