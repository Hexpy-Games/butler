import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exchangeCompleteRoots } from "../../../../foundation/atomic-root-exchange.ts";
import { writeJsonFileAtomic } from "../../../persistence/atomic-json-store.ts";
import type { ProjectLedgerCorePublication, ProjectLedgerHead } from "./contracts.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";

export type ProjectLedgerRecordUpdate = {
  id: string;
  kind?: string;
  title?: string;
  status?: string;
  body?: string;
  spec?: string;
  acceptance?: string;
  validation?: string;
  review?: string;
  report?: string;
  implementation?: string;
  mitigation?: string;
  reason?: string;
  codeCommits?: string;
  ledgerCommits?: string;
};

type ProjectLedgerEffectResult = {
  schema: "butler.btcc-project-ledger-effect-result.v1";
  publicationId: string;
  effectKey: string;
  updatedRecords: Array<{ id: string; kind?: string }>;
  baseHead: ProjectLedgerHead;
  currentHead: ProjectLedgerHead;
  promotion: unknown;
  observation: unknown;
};

type EffectOccurrence = {
  schema: "butler.btcc-project-ledger-effect-occurrence.v1";
  effectKey: string;
  updatesSha256: string;
  publicationId: string;
  status: "pending" | "observed";
  result?: ProjectLedgerEffectResult;
};

export class ProjectLedgerEffectConflictError extends Error {
  readonly code = "project_ledger_effect_occurrence_conflict";

  constructor(readonly effectKey: string) {
    super("The admitted Project Ledger effect occurrence already has different content");
    this.name = "ProjectLedgerEffectConflictError";
  }
}

export async function applyProjectLedgerRecordUpdates(input: {
  butlerData: string;
  projectRoot: string;
  effectKey: string;
  updates: ProjectLedgerRecordUpdate[];
}): Promise<ProjectLedgerEffectResult> {
  if (input.updates.length === 0) {
    throw new Error("Project Ledger effect requires at least one record update");
  }
  const core = await loadProjectLedgerCore();
  const updatesSha256 = digest(stableJson(input.updates));
  const occurrenceId = digest(stableJson({
    schema: "butler.btcc-project-ledger-effect.v1",
    projectRoot: input.projectRoot,
    effectKey: input.effectKey,
  }));
  const root = join(input.butlerData, "runtime", "btcc-project-ledger-effects");
  const occurrencePath = join(root, "occurrences", `${occurrenceId}.json`);
  const occurrence = loadOccurrence(occurrencePath);
  if (occurrence && occurrence.updatesSha256 !== updatesSha256) {
    throw new ProjectLedgerEffectConflictError(input.effectKey);
  }
  if (occurrence?.status === "observed" && occurrence.result) return occurrence.result;
  const publicationId = occurrence?.publicationId ?? digest(stableJson({
    schema: "butler.btcc-project-ledger-effect-publication.v1",
    occurrenceId,
    updatesSha256,
  }));
  const candidateRoot = join(root, "candidates", publicationId);
  const journalPath = join(root, "journals", `${publicationId}.json`);
  const existing = loadJournal(journalPath);
  const expectedBase = existing?.base ?? await observeProjectLedgerHead(input.projectRoot);
  const transaction = {
    publicationId,
    canonicalRoot: input.projectRoot,
    candidateRoot,
    journalPath,
    expectedBase,
  };
  const prepared = preparedPublication(existing)
    ? core.loadPreparedProjectLedgerPublication(transaction) as ProjectLedgerCorePublication
    : core.prepareProjectLedgerPublication({
        ...transaction,
        materialize(projectRoot: string) {
          for (const update of input.updates) {
            applyRecordUpdate(core, projectRoot, update);
          }
          for (const view of ["dashboard", "handoff", "roadmap"]) {
            core.render(projectRoot, view, { write: true });
          }
          const check = core.check(projectRoot);
          if (!check.ok) {
            throw new Error(
              `Prepared Project Ledger effect failed validation: ${stableJson(check.issues ?? [])}`,
            );
          }
        },
      }) as ProjectLedgerCorePublication;
  writeJsonFileAtomic(occurrencePath, {
    schema: "butler.btcc-project-ledger-effect-occurrence.v1",
    effectKey: input.effectKey,
    updatesSha256,
    publicationId,
    status: "pending",
  } satisfies EffectOccurrence);
  const promotion = core.promoteProjectLedgerPublication(prepared, exchangeCompleteRoots);
  const observation = core.observeProjectLedgerPromotion(prepared);
  const result: ProjectLedgerEffectResult = {
    schema: "butler.btcc-project-ledger-effect-result.v1",
    publicationId,
    effectKey: input.effectKey,
    updatedRecords: input.updates.map(({ id, kind }) => ({ id, ...(kind ? { kind } : {}) })),
    baseHead: prepared.base,
    currentHead: await observeProjectLedgerHead(input.projectRoot),
    promotion,
    observation,
  };
  writeJsonFileAtomic(occurrencePath, {
    schema: "butler.btcc-project-ledger-effect-occurrence.v1",
    effectKey: input.effectKey,
    updatesSha256,
    publicationId,
    status: "observed",
    result,
  } satisfies EffectOccurrence);
  return result;
}

function applyRecordUpdate(
  core: Awaited<ReturnType<typeof loadProjectLedgerCore>>,
  projectRoot: string,
  update: ProjectLedgerRecordUpdate,
): void {
  const current = core.resolveRecord(projectRoot, {
    id: update.id,
    ...(update.kind ? { kind: update.kind } : {}),
  }).record;
  if (!update.status || !["work", "task", "attempt"].includes(current.kind)) {
    core.updateRecord(projectRoot, updateOptions(update));
    return;
  }
  const path = core.planTransitionPath(current.kind, current.status, update.status);
  for (const status of path.slice(0, -1)) {
    core.updateRecord(projectRoot, { id: current.id, kind: current.kind, status });
  }
  if (path.length > 0 || hasNonStatusUpdate(update)) {
    core.updateRecord(projectRoot, {
      ...updateOptions(update),
      kind: current.kind,
      status: update.status,
    });
  }
}

function hasNonStatusUpdate(update: ProjectLedgerRecordUpdate): boolean {
  return Object.entries(update).some(([key, value]) =>
    key !== "id" && key !== "kind" && key !== "status" && value !== undefined);
}

function updateOptions(update: ProjectLedgerRecordUpdate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  );
}

function loadJournal(path: string): (ProjectLedgerCorePublication & { status: string }) | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as
    ProjectLedgerCorePublication & { status: string };
}

function loadOccurrence(path: string): EffectOccurrence | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as EffectOccurrence;
}

function preparedPublication(journal: { status: string } | null): boolean {
  return Boolean(journal && ["prepared", "committing", "promoted", "observed"]
    .includes(journal.status));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sort(item)]));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
