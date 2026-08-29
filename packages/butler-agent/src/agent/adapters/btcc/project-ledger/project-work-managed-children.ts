import type { ExactLedgerRecord } from "./canonical-ledger-reader.ts";
import { decodeChild, type ProjectWorkChild } from "./project-work-child-codec.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import {
  parseCanonical,
  projectWorkRecordId,
  requestDigest,
} from "./project-work-json.ts";
import { validateManagedProjectWorkRelations } from "./project-work-managed-relations.ts";

export function validateManagedProjectWorkChildren(
  manifest: ProjectWorkManifest,
  records: ExactLedgerRecord[],
): ProjectWorkChild[] {
  const plans: number[] = [];
  const checkpoints: number[] = [];
  const reviews: number[] = [];
  const dispositions: number[] = [];
  const results: number[] = [];
  const children: ProjectWorkChild[] = [];
  for (const record of records) {
    if (record.parentId !== manifest.workId) continue;
    const schema = String(parseCanonical(record.body).schema);
    if (!schema.startsWith(PROJECT_WORK_SCHEMA_PREFIX)) continue;
    const child = decodeKnownChild(schema, record, manifest.workId);
    children.push(child);
    validateIdentity(child);
    validateOrigin(child, manifest);
    if (child.schema === "butler.btcc-project-work-plan.v1")
      plans.push(child.plan.revision);
    if (child.schema === "butler.btcc-project-work-checkpoint.v1")
      checkpoints.push(child.checkpoint.revision);
    if (child.schema === "butler.btcc-project-work-review.v1")
      reviews.push(child.review.revision);
    if (child.schema === "butler.btcc-project-work-disposition.v1")
      dispositions.push(child.disposition.revision);
    if (child.schema === "butler.btcc-project-work-result-reference.v1")
      results.push(child.result.sequence);
    if (child.schema === "butler.btcc-project-work-binding.v1")
      validateBinding(child, manifest);
  }
  exactRevisionSeries(plans, manifest.planRevision);
  exactRevisionSeries(checkpoints, manifest.checkpointRevision);
  exactRevisionSeries(reviews, manifest.reviewRevision);
  exactRevisionSeries(dispositions, manifest.dispositionRevision);
  exactRevisionSeries(results, manifest.resultRefs.length);
  validateManagedProjectWorkRelations(manifest, children);
  return children;
}

function decodeKnownChild(
  schema: string,
  record: ExactLedgerRecord,
  workId: string,
): ProjectWorkChild {
  if (!SCHEMAS.includes(schema as ProjectWorkChild["schema"])) invalid();
  return decodeChild(record.body, {
    schema: schema as ProjectWorkChild["schema"],
    workId,
    recordId: record.id,
  });
}

function validateIdentity(child: ProjectWorkChild): void {
  const identity = child.operationIdentity;
  if (
    identity.kind === "mutation_call" &&
    identity.mutationCallId !== identity.id
  )
    invalid();
  if (
    child.schema !== "butler.btcc-project-work-binding.v1" &&
    child.schema !== "butler.btcc-project-work-closeout-diagnostic.v1" &&
    identity.kind !== "mutation_call" &&
    identity.kind !== "legacy_import"
  )
    invalid();
  if (
    child.schema === "butler.btcc-project-work-plan.v1" &&
    identity.kind !== "legacy_import"
  )
    exactId(child.plan.planRevisionId, "plan", identity.id);
  if (
    child.schema === "butler.btcc-project-work-review.v1" &&
    identity.kind !== "legacy_import"
  )
    exactId(child.review.reviewRevisionId, "review", identity.id);
  if (
    child.schema === "butler.btcc-project-work-disposition.v1" &&
    identity.kind !== "legacy_import"
  )
    exactId(child.disposition.dispositionRevisionId, "disposition", identity.id);
  if (child.schema === "butler.btcc-project-work-result-reference.v1")
    exactId(child.result.resultRef, "result", child.result.toolCallId);
  if (
    child.schema === "butler.btcc-project-work-checkpoint.v1" &&
    identity.kind !== "legacy_import"
  ) {
    const prefix = `${identity.id}\0`;
    const suffix = child.checkpointIdentity.slice(prefix.length);
    if (
      child.checkpointIdentity !== identity.id &&
      (!child.checkpointIdentity.startsWith(prefix) ||
        !CHECKPOINT_SUFFIXES.has(suffix))
    )
      invalid();
    exactId(
      child.checkpoint.checkpointRevisionId,
      "checkpoint",
      child.checkpointIdentity,
    );
  }
  if (child.schema === "butler.btcc-project-work-binding.v1") {
    exactId(
      child.binding.bindingRevisionId,
      "binding",
      `${child.binding.turnId}\0${child.binding.revision}\0${child.workId}`,
    );
    if (
      identity.kind === "binding_revision" &&
      identity.id !== child.binding.bindingRevisionId
    )
      invalid();
  }
  if (child.schema === "butler.btcc-project-work-closeout-diagnostic.v1") {
    const key = requestDigest(
      `btcc-guided-work-closeout-missing.v1\0${child.diagnostic.turnId}\0${child.workId}`,
    );
    exactId(child.diagnostic.diagnosticId, "diagnostic", key);
    if (
      identity.kind !== "closeout_diagnostic" ||
      identity.id !== child.diagnostic.diagnosticId ||
      identity.requestSha256 !==
        requestDigest({
          turnId: child.diagnostic.turnId,
          workId: child.workId,
        })
    )
      invalid();
  }
}

function validateBinding(
  child: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-binding.v1" }
  >,
  manifest: ProjectWorkManifest,
): void {
  const matches = manifest.bindingRefs.filter(
    (binding) =>
      binding.bindingRevisionId === child.binding.bindingRevisionId &&
      binding.turnId === child.binding.turnId &&
      binding.revision === child.binding.revision,
  );
  if (matches.length !== 1 || child.binding.sessionId !== manifest.sessionId)
    invalid();
}

function exactRevisionSeries(actual: number[], expected: number): void {
  const sorted = [...actual].sort((left, right) => left - right);
  if (
    sorted.length !== expected ||
    sorted.some((revision, index) => revision !== index + 1)
  )
    invalid();
}

function validateOrigin(
  child: ProjectWorkChild,
  manifest: ProjectWorkManifest,
): void {
  const turnId =
    child.schema === "butler.btcc-project-work-plan.v1"
      ? child.plan.originTurnId
      : child.schema === "butler.btcc-project-work-checkpoint.v1"
        ? child.checkpoint.originTurnId
        : child.schema === "butler.btcc-project-work-review.v1"
          ? child.review.originTurnId
          : child.schema === "butler.btcc-project-work-disposition.v1"
            ? child.disposition.originTurnId
            : child.schema === "butler.btcc-project-work-result-reference.v1"
              ? child.result.originTurnId
              : child.schema === "butler.btcc-project-work-binding.v1"
                ? child.binding.turnId
                : child.diagnostic.turnId;
  if (!manifest.bindingRefs.some((binding) => binding.turnId === turnId))
    invalid();
}

function exactId(actual: string, kind: string, seed: string): void {
  if (actual !== projectWorkRecordId(kind, seed)) invalid();
}

const CHECKPOINT_SUFFIXES = new Set([
  "conception",
  "plan",
  "review-entry",
  "review-exit",
  "validation-entry",
  "validation-exit",
  "disposition",
]);
const PROJECT_WORK_SCHEMA_PREFIX = "butler.btcc-project-work-";
const SCHEMAS: ProjectWorkChild["schema"][] = [
  "butler.btcc-project-work-plan.v1",
  "butler.btcc-project-work-checkpoint.v1",
  "butler.btcc-project-work-review.v1",
  "butler.btcc-project-work-disposition.v1",
  "butler.btcc-project-work-result-reference.v1",
  "butler.btcc-project-work-binding.v1",
  "butler.btcc-project-work-closeout-diagnostic.v1",
];

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
