import { expect, test } from "bun:test";
import { artifactReviewAuthority } from
  "../../packages/butler-agent/src/agent/btcc/review/source-authority.ts";

test("artifact Review exposes only the immutable source for workspace inspection", () => {
  const reviewSourceRef = { id: "workspace-revision", sha256: "revision-sha" };
  const authority = artifactReviewAuthority({
    baseline: {
      observationScopeRefs: [
        "workspace:/stale/admission-snapshot",
        "ledger:project",
        "web:public",
      ],
      mutation: { kind: "forbidden" },
    },
    reviewSourceRef,
  });

  expect(authority).toEqual({
    observationScopeRefs: ["ledger:project", "web:public"],
    mutation: { kind: "validation_overlay_only", reviewSourceRef },
  });
});
