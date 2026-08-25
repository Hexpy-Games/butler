import type { ExactLedgerTargetPrecondition } from "./canonical-ledger-reader.ts";
import {
  readProjectLedgerEffectOccurrence,
  type ProjectLedgerEffectAttempt,
} from "./external-effect-occurrence.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import type { ResolvedProjectWorkScope } from "./project-work-contracts.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import {
  publicationPaths,
  readPublicationReceipt,
} from "./publication-recovery/index.ts";
import {
  requireProjectWorkPublicationProof,
  type ProjectWorkPublishedRecord,
} from "./project-work-publication-proof.ts";

/** Requires each managed operation to have an exact observed predecessor receipt. */
export function validateProjectWorkOccurrenceProofs(input: {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  children: ProjectWorkChild[];
  publishedRecords: ProjectWorkPublishedRecord[];
  manifest?: ProjectWorkManifest;
}): void {
  if (input.manifest)
    validateManifestProof(
      input,
      input.manifest,
      publishedRecord(input.publishedRecords, input.manifest.workId, "work"),
    );
  for (const child of input.children) {
    const identity = child.operationIdentity;
    const occurrence = readProjectLedgerEffectOccurrence({
      butlerData: input.butlerData,
      ledgerProjectId: input.scope.ledgerProjectId,
      ledgerRoot: input.scope.ledgerRoot,
      operationIdentity: { kind: identity.kind, id: identity.id },
      requestSha256: identity.requestSha256,
    });
    if (!occurrence) throw new Error("project_work_occurrence_receipt_missing");
    const attempt =
      child.schema === "butler.btcc-project-work-result-reference.v1"
        ? occurrence.attempts.at(-1) ?? invalid()
        : appliedAttemptForChild(occurrence.attempts, child);
    verifyObserved(input, occurrence.occurrenceId, attempt);
    const record = childRecord(child);
    requireProjectWorkPublicationProof(
      attempt.targetPreconditions,
      publishedRecord(input.publishedRecords, record.id, record.kind),
    );
  }
}

function validateManifestProof(
  input: { butlerData: string; scope: ResolvedProjectWorkScope },
  manifest: ProjectWorkManifest,
  published: ProjectWorkPublishedRecord,
): void {
  const identity = manifest.operationIdentity;
  const occurrence = readProjectLedgerEffectOccurrence({
    butlerData: input.butlerData,
    ledgerProjectId: input.scope.ledgerProjectId,
    ledgerRoot: input.scope.ledgerRoot,
    operationIdentity: { kind: identity.kind, id: identity.id },
    requestSha256: identity.requestSha256,
  });
  if (!occurrence) throw new Error("project_work_occurrence_receipt_missing");
  const attempt = occurrence.attempts.at(-1);
  if (
    !attempt ||
    !exactTarget(attempt.targetPreconditions, {
      id: manifest.workId,
      kind: "work",
      parentId: null,
    })
  )
    invalid();
  verifyObserved(input, occurrence.occurrenceId, attempt);
  requireProjectWorkPublicationProof(attempt.targetPreconditions, published);
}

function verifyObserved(
  input: { butlerData: string; scope: ResolvedProjectWorkScope },
  occurrenceId: string,
  attempt: ProjectLedgerEffectAttempt,
): void {
  try {
    const receipt = readPublicationReceipt(
      publicationPaths({
        butlerData: input.butlerData,
        publicationId: attempt.publicationId,
      }).receiptPath,
      {
      ledgerRoot: input.scope.ledgerRoot,
      occurrenceId,
      attempt,
      },
    );
    if (!receipt || receipt.status !== "observed") invalid();
  } catch {
    invalid();
  }
}

function appliedAttemptForChild(
  attempts: ProjectLedgerEffectAttempt[],
  child: ProjectWorkChild,
): ProjectLedgerEffectAttempt {
  const record = childRecord(child);
  const attempt = attempts.at(-1);
  if (
    !attempt ||
    !exactTarget(attempt.targetPreconditions, {
      ...record,
      parentId: child.workId,
    })
  )
    invalid();
  return attempt;
}

function exactTarget(
  targets: ExactLedgerTargetPrecondition[],
  expected: { id: string; kind: string; parentId: string | null },
): boolean {
  return (
    targets.filter(
      (target) =>
        target.id === expected.id &&
        target.kind === expected.kind &&
        target.parentId === expected.parentId,
    ).length === 1
  );
}

function childRecord(
  child: ProjectWorkChild,
): { id: string; kind: "plan" | "reference" } {
  if (child.schema === "butler.btcc-project-work-plan.v1")
    return { id: child.plan.planRevisionId, kind: "plan" };
  const id =
    child.schema === "butler.btcc-project-work-checkpoint.v1"
      ? child.checkpoint.checkpointRevisionId
      : child.schema === "butler.btcc-project-work-review.v1"
        ? child.review.reviewRevisionId
        : child.schema === "butler.btcc-project-work-disposition.v1"
          ? child.disposition.dispositionRevisionId
          : child.schema === "butler.btcc-project-work-result-reference.v1"
            ? child.result.resultRef
            : child.schema === "butler.btcc-project-work-binding.v1"
            ? child.binding.bindingRevisionId
            : child.schema ===
                "butler.btcc-project-work-closeout-diagnostic.v1"
              ? child.diagnostic.diagnosticId
              : invalid();
  return { id, kind: "reference" };
}

function publishedRecord(
  records: ProjectWorkPublishedRecord[],
  id: string,
  kind: ProjectWorkPublishedRecord["kind"],
): ProjectWorkPublishedRecord {
  const matches = records.filter(
    (record) => record.id === id && record.kind === kind,
  );
  if (matches.length !== 1) return invalid();
  return matches[0]!;
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
