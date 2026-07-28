import { expect, test } from "bun:test";
import { projectReviewValidationSource, taskReviewAuthority } from
  "../../packages/butler-agent/src/agent/btcc/review/source-authority.ts";

test("Task Review exposes exact result reads and only the immutable workspace source", () => {
  const reviewSourceRef = { id: "workspace-revision", sha256: "revision-sha" };
  const authority = taskReviewAuthority({
    baseline: {
      observationScopeRefs: [
        "workspace:/stale/admission-snapshot",
        "ledger:project",
        "web:public",
      ],
      mutation: { kind: "forbidden" },
    },
    result: {
      kind: "workspace_artifact",
      workspaceRevisionRef: reviewSourceRef,
      operationResultReadScopeRefs: ["operation-result:result-1"],
    } as never,
    predecessorResults: [{
      operationResultReadScopeRefs: ["operation-result:predecessor-result"],
    } as never],
  });

  expect(authority).toEqual({
    observationScopeRefs: [
      "ledger:project",
      "web:public",
      "operation-result:result-1",
      "operation-result:predecessor-result",
    ],
    mutation: { kind: "validation_overlay_only", reviewSourceRef },
  });
  expect(projectReviewValidationSource({
    kind: "workspace_artifact",
    workspaceRevisionRef: reviewSourceRef,
    workspaceRevision: {
      ref: reviewSourceRef,
      workspaceRef: { id: "workspace", sha256: "workspace-sha" },
      producingWorkRef: { id: "work", sha256: "work-sha" },
      producingTaskRef: { id: "task", sha256: "task-sha" },
      producingAttemptRef: { id: "attempt", sha256: "attempt-sha" },
      baseAcceptedRevisionRefs: [],
      artifactRevisionRefs: [],
      targetSnapshotRef: { id: "snapshot", sha256: "snapshot-sha" },
      producedByOperationRefs: [],
    },
  } as never)).toEqual({
    reviewSourceRef,
    reviewValidationSource: expect.objectContaining({ ref: reviewSourceRef }),
  });
});
