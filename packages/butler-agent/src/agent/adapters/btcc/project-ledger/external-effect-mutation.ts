import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exchangeCompleteRoots } from "../../../../foundation/complete-root-commit/index.ts";
import { writeJsonFileAtomic } from "../../../persistence/atomic-json-store.ts";
import type { ProjectLedgerCorePublication, ProjectLedgerHead } from "./contracts.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { observeProjectLedgerHead } from "./observe-project-ledger.ts";
import {
  applyProjectLedgerRecordUpdate,
  type ProjectLedgerRecordUpdate,
} from "./external-effect-record-update.ts";
export type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";

export type ProjectLedgerEffectResult = {
  schema: "butler.btcc-project-ledger-effect-result.v1";
  publicationId: string;
  effectKey: string;
  updatedRecords: Array<{ id: string; kind?: string }>;
  baseHead: ProjectLedgerHead;
  currentHead: ProjectLedgerHead;
  promotion: unknown;
  observation: unknown;
};

export type ProjectLedgerEffectReconciliation =
  | { status: "applied"; result: ProjectLedgerEffectResult }
  | { status: "not_applied" }
  | { status: "uncertain"; message: string };

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
  const { root, occurrenceId, occurrencePath } = effectPaths(input);
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
            applyProjectLedgerRecordUpdate(core, projectRoot, update);
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

export async function reconcileProjectLedgerRecordUpdates(input: {
  butlerData: string;
  projectRoot: string;
  effectKey: string;
  updates: ProjectLedgerRecordUpdate[];
}): Promise<ProjectLedgerEffectReconciliation> {
  const { occurrencePath } = effectPaths(input);
  const occurrence = loadOccurrence(occurrencePath);
  if (!occurrence) return { status: "not_applied" };
  const updatesSha256 = digest(stableJson(input.updates));
  if (occurrence.updatesSha256 !== updatesSha256) {
    return {
      status: "uncertain",
      message: "The stored Project Ledger effect occurrence has different content.",
    };
  }
  if (occurrence.status === "observed" && occurrence.result) {
    return { status: "applied", result: occurrence.result };
  }
  try {
    return {
      status: "applied",
      result: await applyProjectLedgerRecordUpdates(input),
    };
  } catch (error) {
    return {
      status: "uncertain",
      message: error instanceof Error
        ? error.message
        : "The Project Ledger effect could not be reconciled safely.",
    };
  }
}

function effectPaths(input: {
  butlerData: string;
  projectRoot: string;
  effectKey: string;
}): { root: string; occurrenceId: string; occurrencePath: string } {
  const occurrenceId = digest(stableJson({
    schema: "butler.btcc-project-ledger-effect.v1",
    projectRoot: input.projectRoot,
    effectKey: input.effectKey,
  }));
  const root = join(input.butlerData, "runtime", "btcc-project-ledger-effects");
  return {
    root,
    occurrenceId,
    occurrencePath: join(root, "occurrences", `${occurrenceId}.json`),
  };
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
