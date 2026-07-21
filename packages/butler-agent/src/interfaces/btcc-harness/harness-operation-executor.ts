import { createHash } from "node:crypto";
import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";
import { contentRef } from "../../agent/btcc/core/index.ts";

type OperationExecutor = BtccRuntimeDependencies["operations"];
type PerformInput = Parameters<OperationExecutor["perform"]>[0];
type OperationResult = Awaited<ReturnType<OperationExecutor["perform"]>>;

export class HarnessOperationExecutor implements OperationExecutor {
  callCount = 0;

  async perform({ request }: PerformInput): Promise<OperationResult> {
    this.callCount += 1;
    if (request.kind === "repository_promotion") {
      const content = "journaled complete-target promotion committed";
      const transaction = record("repository-promotion-transaction", {
        requestId: request.requestId,
        authorizationRef: request.authorizationRef,
        candidateRef: request.candidateRef,
        resolutionRef: request.resolutionRef,
        baselineRef: request.baselineRef,
        commitPrimitive: "atomic_root_exchange",
      });
      const prepared = journal(transaction.ref, undefined, "prepared");
      const baselineVerified = journal(transaction.ref, prepared.ref, "baseline_verified");
      const intent = journal(transaction.ref, baselineVerified.ref, "commit_intent_durable");
      const commitReceipt = record("promotion-commit-receipt", {
        transactionRef: transaction.ref,
        targetStateAfterSha256: digest(content),
        primitive: "atomic_root_exchange",
      });
      const observed = journal(transaction.ref, intent.ref, "commit_observed", {
        commitReceiptRef: commitReceipt.ref,
      });
      const promotedSnapshot = record("promoted-target-snapshot", {
        transactionRef: transaction.ref,
        commitReceiptRef: commitReceipt.ref,
        completeTargetSha256: digest(content),
      });
      const cleanupReceipt = record("promotion-cleanup-receipt", {
        transactionRef: transaction.ref,
        commitObservedJournalRef: observed.ref,
        removedOwnedRootRefs: [],
      });
      const closed = journal(transaction.ref, observed.ref, "closed", {
        cleanupReceiptRef: cleanupReceipt.ref,
        promotedSnapshotRef: promotedSnapshot.ref,
      });
      return {
        requestId: request.requestId,
        outcome: "promoted",
        observationRef: ref("promotion-operation", request.requestId, content),
        transactionRef: transaction.ref,
        commitJournalRef: closed.ref,
        promotionReceiptRef: commitReceipt.ref,
        promotedSnapshotRef: promotedSnapshot.ref,
        promotionRecords: {
          transaction,
          journals: [prepared, baselineVerified, intent, observed, closed],
          commitReceipt,
          promotedSnapshot,
          cleanupReceipt,
        },
        content,
      };
    }
    if (request.kind === "workspace_artifact_action") {
      const content = `workspace artifact: ${request.relativeTarget}`;
      return {
        requestId: request.requestId,
        outcome: "workspace_artifact_applied",
        observationRef: ref("workspace-operation", request.requestId, content),
        artifactRevisionRef: ref("artifact-revision", request.requestId, request.input),
        targetSnapshotRef: ref("materializable-snapshot", request.requestId, content),
        content,
      };
    }
    if (request.kind === "review_validation") {
      const content = "isolated review validation passed";
      return {
        requestId: request.requestId,
        outcome: "review_validated",
        observationRef: ref("review-validation", request.requestId, content),
        validationReceiptRef: ref("review-validation-receipt", request.requestId, content),
        content,
      };
    }
    const content = observationFor(request.capabilityRef);
    return {
      requestId: request.requestId,
      outcome: "observed",
      observationRef: ref("harness-observation", request.requestId, content),
      content,
    };
  }
}

function record(kind: string, body: Record<string, unknown>) {
  return { ref: contentRef(kind, body), ...body };
}

function journal(
  transactionRef: { id: string; sha256: string },
  previousRef: { id: string; sha256: string } | undefined,
  state: string,
  extra: Record<string, unknown> = {},
) {
  const body = {
    transactionRef,
    ...(previousRef ? { previousRef } : {}),
    sequence: previousRef ? journalSequence(state) : 1,
    state,
    ...extra,
  };
  return { ref: contentRef("repository-promotion-journal", body), ...body };
}

function journalSequence(state: string): number {
  return ["prepared", "baseline_verified", "commit_intent_durable", "commit_observed", "closed"]
    .indexOf(state) + 1;
}

function observationFor(capabilityRef: string): string {
  switch (capabilityRef) {
    case "weather:seoul-current":
      return "서울은 현재 맑고 24도입니다.";
    case "meme:current-first":
      return "현재 밈 관찰 1: 월요일을 버티는 직장인 고양이";
    case "meme:current-second":
      return "현재 밈 관찰 2: 예상과 현실을 비교하는 두 장면 형식";
    default:
      throw new Error(`Unknown harness observation capability: ${capabilityRef}`);
  }
}

function ref(kind: string, identity: string, content: string) {
  return {
    id: digest(`btcc-${kind}.v1\0${identity}\0${content}`),
    sha256: digest(content),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
