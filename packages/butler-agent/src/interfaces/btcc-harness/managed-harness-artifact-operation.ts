import {
  asRecord,
  executionTargetKind,
  nestedValue,
} from "./managed-harness-state.ts";

export function artifactExecutionOperation(input: {
  state: Record<string, unknown>;
  checkpointId: string;
  operationResultCount: number;
}): unknown | null {
  if (input.operationResultCount > 0) return null;
  const target = asRecord(nestedValue(input.state, "executionTarget", "target"));

  if (executionTargetKind(input.state) === "repository_promotion") {
    return {
      kind: "operation_requests",
      requests: [{
        requestId: `repository-promotion:${input.checkpointId}`,
        publicTitle: "승인된 결과를 프로젝트에 반영합니다",
        kind: "repository_promotion",
        capabilityRef: "harness:promote-artifact",
        authorizationRef: target.authorizationRef,
        candidateRef: target.candidateRef,
        resolutionRef: target.resolutionRef,
        baselineRef: target.baselineRef,
        finalSnapshotRef: target.finalSnapshotRef,
        input: { operation: "승인된 후보를 완전 대상 교환으로 반영한다" },
      }],
    };
  }

  if (executionTargetKind(input.state) !== "provisioned_workspace") return null;
  const mutationScope = asRecord(target.mutationScope);
  if (mutationScope.kind === "read_only") {
    return {
      kind: "operation_requests",
      requests: [{
        requestId: `workspace-observation:${input.checkpointId}`,
        publicTitle: "격리된 작업공간의 현재 결과를 확인합니다",
        kind: "workspace_artifact_observation",
        capabilityRef: "harness:observe-artifact",
        workspaceRef: target.workspaceRef,
        input: { operation: "현재 격리 결과를 통합 검증 대상으로 확인한다" },
      }],
    };
  }

  return {
    kind: "operation_requests",
    requests: [{
      requestId: `workspace-action:${input.checkpointId}`,
      publicTitle: "격리된 작업공간에 결과를 작성합니다",
      kind: "workspace_artifact_action",
      capabilityRef: "harness:write-artifact",
      workspaceRef: target.workspaceRef,
      relativeTarget: "guide.md",
      input: { content: "승인된 작업 내용을 격리 작업공간에 작성한다" },
    }],
  };
}
