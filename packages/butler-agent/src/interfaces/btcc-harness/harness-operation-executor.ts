import { createHash } from "node:crypto";
import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";

type OperationExecutor = BtccRuntimeDependencies["operations"];
type PerformInput = Parameters<OperationExecutor["perform"]>[0];
type OperationResult = Awaited<ReturnType<OperationExecutor["perform"]>>;

export class HarnessOperationExecutor implements OperationExecutor {
  callCount = 0;

  async perform({ request }: PerformInput): Promise<OperationResult> {
    this.callCount += 1;
    if (request.kind === "repository_promotion") {
      const content = "journaled complete-target promotion committed";
      return {
        requestId: request.requestId,
        outcome: "promoted",
        observationRef: ref("promotion-operation", request.requestId, content),
        transactionRef: ref("promotion-transaction", request.requestId, content),
        commitJournalRef: ref("promotion-journal", request.requestId, "commit-observed"),
        promotionReceiptRef: ref("promotion-receipt", request.requestId, content),
        promotedSnapshotRef: ref("promoted-snapshot", request.requestId, content),
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
