import type { DurableWorkView } from "../../../btcc/work/index.ts";
import {
  readStableExactProjectLedgerSnapshot,
  type ExactLedgerRecord,
  type ExactLedgerTarget,
} from "./canonical-ledger-reader.ts";
import { decodeChild } from "./project-work-child-codec.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import {
  decodeManifest,
  type ProjectWorkManifest,
} from "./project-work-codec.ts";
import { childPath, workPath } from "./project-work-json.ts";
import { validateManagedProjectWorkChildren } from "./project-work-managed-children.ts";
import { managedProjectWorkTargets } from "./project-work-managed-targets.ts";
import { validateProjectWorkOccurrenceProofs } from "./project-work-occurrence-proof.ts";
import type { ProjectWorkPublishedRecord } from "./project-work-publication-proof.ts";
import { validateProjectWorkOfficialMetadata } from "./project-work-official-metadata.ts";
import { hydrateProjectWorkManifest } from "./project-work-snapshot-validation.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";

export type CurrentProjectWorkSnapshot = {
  manifest: ProjectWorkManifest;
  view: DurableWorkView;
  children: ProjectWorkChild[];
};

export async function readCurrentProjectWork(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  workId: string;
}): Promise<CurrentProjectWorkSnapshot | null> {
  return readCurrentProjectWorkAttempt(input, 1);
}

async function readCurrentProjectWorkAttempt(
  input: {
    butlerData: string;
    scope: ResolvedProjectWorkScope;
    workId: string;
  },
  attempt: number,
): Promise<CurrentProjectWorkSnapshot | null> {
  const workTarget = target(input.scope, "work", input.workId, null);
  const initial = await readStableExactProjectLedgerSnapshot({
    projectRoot: input.scope.ledgerRoot,
    targets: [workTarget],
  });
  const record = initial.records[0];
  if (!record) return null;
  const manifest = decodeManifest(record.body, input);
  await validateProjectWorkOfficialMetadata(input.scope, initial, manifest);
  const childTargets = await managedProjectWorkTargets(
    input.scope,
    manifest,
    targetsForManifest(input.scope, manifest),
  );
  const stable = await readStableExactProjectLedgerSnapshot({
    projectRoot: input.scope.ledgerRoot,
    targets: [workTarget, ...childTargets],
  });
  if (stable.records.length !== 1 + childTargets.length) invalid();
  const currentManifest = decodeManifest(
    requiredRecord(stable.records, input.workId).body,
    input,
  );
  const stableMetadata = await validateProjectWorkOfficialMetadata(
    input.scope,
    stable,
    currentManifest,
  );
  if (pointerSignature(currentManifest) !== pointerSignature(manifest)) {
    if (attempt >= 3) throw new Error("project_work_snapshot_unstable");
    return readCurrentProjectWorkAttempt(input, attempt + 1);
  }
  const dependencies = dependencyTargets(
    input.scope,
    currentManifest,
    stable.records,
  );
  const allTargets = uniqueTargets([
    workTarget,
    ...childTargets,
    ...dependencies,
  ]);
  if (allTargets.length === 1 + childTargets.length)
    return hydrate(input, currentManifest, stable.records, stableMetadata);
  const complete = await readStableExactProjectLedgerSnapshot({
    projectRoot: input.scope.ledgerRoot,
    targets: allTargets,
  });
  if (complete.records.length !== allTargets.length) invalid();
  const completeManifest = decodeManifest(
    requiredRecord(complete.records, input.workId).body,
    input,
  );
  const completeMetadata = await validateProjectWorkOfficialMetadata(
    input.scope,
    complete,
    completeManifest,
  );
  if (
    pointerSignature(completeManifest) !== pointerSignature(currentManifest)
  ) {
    if (attempt >= 3) throw new Error("project_work_snapshot_unstable");
    return readCurrentProjectWorkAttempt(input, attempt + 1);
  }
  return hydrate(input, completeManifest, complete.records, completeMetadata);
}

export async function requireCurrentProjectWork(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  workId: string;
}): Promise<CurrentProjectWorkSnapshot> {
  const current = await readCurrentProjectWork(input);
  if (!current) throw new Error("project_work_record_missing");
  return current;
}

export async function readManagedProjectWorkChild<
  T extends Parameters<typeof decodeChild>[1]["schema"],
>(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  workId: string;
  id: string;
  kind: "plan" | "reference";
  schema: T;
}) {
  const childTarget = target(
    input.scope,
    input.kind,
    input.id,
    input.workId,
  );
  const snapshot = await readStableExactProjectLedgerSnapshot({
    projectRoot: input.scope.ledgerRoot,
    targets: [childTarget],
  });
  if (snapshot.records.length !== 1) invalid();
  const child = decodeChild(snapshot.records[0]!.body, {
    schema: input.schema,
    workId: input.workId,
    recordId: input.id,
  });
  const publishedRecords = await validateProjectWorkOfficialMetadata(
    input.scope,
    snapshot,
  );
  validateProjectWorkOccurrenceProofs({
    butlerData: input.butlerData,
    scope: input.scope,
    children: [child],
    publishedRecords,
  });
  return child;
}

function hydrate(
  input: { butlerData: string; scope: ResolvedProjectWorkScope },
  manifest: ProjectWorkManifest,
  records: ExactLedgerRecord[],
  publishedRecords: ProjectWorkPublishedRecord[],
): CurrentProjectWorkSnapshot {
  const children = validateManagedProjectWorkChildren(manifest, records);
  validateProjectWorkOccurrenceProofs({
    ...input,
    manifest,
    children,
    publishedRecords,
  });
  const view = hydrateProjectWorkManifest(
    manifest,
    (id) => requiredRecord(records, id).body,
  );
  return { manifest, view, children };
}

function targetsForManifest(
  scope: ResolvedProjectWorkScope,
  manifest: ProjectWorkManifest,
): ExactLedgerTarget[] {
  const targets: ExactLedgerTarget[] = [];
  const add = (kind: "plan" | "reference", id: string | undefined) => {
    if (id) targets.push(target(scope, kind, id, manifest.workId));
  };
  add("plan", manifest.currentPlanRevisionId);
  add("reference", manifest.latestCheckpointRevisionId);
  add("reference", manifest.latestPlanReviewRevisionId);
  add("reference", manifest.latestResultReviewRevisionId);
  add("reference", manifest.latestCompletionValidationRevisionId);
  add("reference", manifest.latestDispositionRevisionId);
  for (const binding of manifest.bindingRefs)
    add("reference", binding.bindingRevisionId);
  for (const result of manifest.resultRefs) add("reference", result.resultRef);
  const unique = new Map(
    targets.map((item) => [`${item.kind}\0${item.id}`, item]),
  );
  if (unique.size !== targets.length) invalid();
  return [...unique.values()];
}

function dependencyTargets(
  scope: ResolvedProjectWorkScope,
  manifest: ProjectWorkManifest,
  records: ExactLedgerRecord[],
): ExactLedgerTarget[] {
  const targets: ExactLedgerTarget[] = [];
  const add = (kind: "plan" | "reference", id?: string) => {
    if (id) targets.push(target(scope, kind, id, manifest.workId));
  };
  if (manifest.latestCheckpointRevisionId) {
    const checkpoint = decodeChild(
      requiredRecord(records, manifest.latestCheckpointRevisionId).body,
      {
        schema: "butler.btcc-project-work-checkpoint.v1",
        workId: manifest.workId,
        recordId: manifest.latestCheckpointRevisionId,
      },
    ).checkpoint;
    add("plan", checkpoint.planRevisionId);
  }
  for (const id of [
    manifest.latestPlanReviewRevisionId,
    manifest.latestResultReviewRevisionId,
    manifest.latestCompletionValidationRevisionId,
  ]) {
    if (!id) continue;
    const review = decodeChild(requiredRecord(records, id).body, {
      schema: "butler.btcc-project-work-review.v1",
      workId: manifest.workId,
      recordId: id,
    }).review;
    add("plan", review.boundPlanRevisionId);
    add("reference", review.boundResultReviewRevisionId);
    for (const resultRef of review.boundResultRefs) add("reference", resultRef);
  }
  return uniqueTargets(targets);
}

function uniqueTargets(targets: ExactLedgerTarget[]): ExactLedgerTarget[] {
  return [
    ...new Map(
      targets.map((item) => [`${item.kind}\0${item.id}`, item]),
    ).values(),
  ];
}

function target(
  scope: ResolvedProjectWorkScope,
  kind: "work" | "plan" | "reference",
  id: string,
  parentId: string | null,
): ExactLedgerTarget {
  return {
    id,
    kind,
    parentId,
    path:
      kind === "work"
        ? workPath(scope.ledgerProjectId, id)
        : childPath(scope.ledgerProjectId, kind, id),
  };
}

function requiredRecord(
  records: ExactLedgerRecord[],
  id: string,
): ExactLedgerRecord {
  const matches = records.filter((record) => record.id === id);
  if (matches.length !== 1) return invalid();
  return matches[0]!;
}
function pointerSignature(manifest: ProjectWorkManifest): string {
  return JSON.stringify({
    plan: manifest.currentPlanRevisionId ?? null,
    checkpoint: manifest.latestCheckpointRevisionId ?? null,
    planReview: manifest.latestPlanReviewRevisionId ?? null,
    resultReview: manifest.latestResultReviewRevisionId ?? null,
    completion: manifest.latestCompletionValidationRevisionId ?? null,
    disposition: manifest.latestDispositionRevisionId ?? null,
    bindings: manifest.bindingRefs,
    results: manifest.resultRefs,
  });
}
function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
