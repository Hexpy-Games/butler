import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import type { ExactLedgerTargetPrecondition } from "./canonical-ledger-reader.ts";
import type { ProjectWorkOperationIdentity } from "./project-work-contracts.ts";
import type { CurrentProjectWorkSnapshot } from "./project-work-snapshot.ts";
import {
  canonicalProjectWorkChildBody,
  type ProjectWorkChild,
} from "./project-work-child-codec.ts";

export type ProjectWorkOperationOutcome = {
  targets: ExactLedgerTargetPrecondition[];
  preparedUpdates: ProjectLedgerRecordUpdate[];
};

export function proveProjectWorkOperationReceipt(
  outcome: ProjectWorkOperationOutcome,
  workId: string,
  children: ProjectWorkChild[],
  requireWorkTarget = true,
): void {
  if (
    requireWorkTarget &&
    outcome.targets.filter(
      (target) =>
        target.id === workId &&
        target.kind === "work" &&
        target.parentId === null,
    ).length !== 1
  )
    invalid();
  for (const child of children) {
    const record = childRecord(child);
    if (
      outcome.targets.filter(
        (target) =>
          target.id === record.id &&
          target.kind === record.kind &&
          target.parentId === workId,
      ).length !== 1
    )
      invalid();
    const body = canonicalProjectWorkChildBody(child);
    if (outcome.preparedUpdates.length > 0) {
      const updates = outcome.preparedUpdates.filter(
        (update) => update.id === record.id && update.kind === record.kind,
      );
      if (updates.length !== 1 || updates[0]!.body !== body) invalid();
    }
  }
  if (
    outcome.preparedUpdates.length > 0 &&
    outcome.preparedUpdates.some((update) => update.body === undefined)
  )
    invalid();
}

export function proveProjectWorkRelationOutcome(input: {
  outcome: ProjectWorkOperationOutcome;
  current: CurrentProjectWorkSnapshot;
  identity: ProjectWorkOperationIdentity;
}): void {
  proveProjectWorkOperationReceipt(
    input.outcome,
    input.current.view.workId,
    input.current.children.filter(
      (child) => child.operationIdentity.id === input.identity.id,
    ),
  );
}

function childRecord(child: ProjectWorkChild) {
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
              : child.diagnostic.diagnosticId;
  return { id, kind: "reference" };
}

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
