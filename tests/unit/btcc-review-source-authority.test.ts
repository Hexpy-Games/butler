import { expect, test } from "bun:test";
import { taskReviewAuthority } from
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
  });

  expect(authority).toEqual({
    observationScopeRefs: [
      "ledger:project",
      "web:public",
      "operation-result:result-1",
    ],
    mutation: { kind: "validation_overlay_only", reviewSourceRef },
  });
});
