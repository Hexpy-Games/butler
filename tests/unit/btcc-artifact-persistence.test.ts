import { describe, expect, test } from "bun:test";
import { validateArtifactPersistence } from
  "../../packages/butler-agent/src/agent/btcc/planning/plan-graph/validate-artifact-persistence.ts";

const noPromotion = { promotionTaskRefs: [] };
const withPromotion = {
  promotionTaskRefs: [{ id: "promotion-task", sha256: "sha256:promotion" }],
};

describe("Goal artifact persistence", () => {
  test("requires repository promotion when accepted Goal persistence is required", () => {
    expect(() => validateArtifactPersistence("required", noPromotion))
      .toThrow("requires artifact persistence");
    expect(() => validateArtifactPersistence("required", withPromotion)).not.toThrow();
  });

  test("forbids repository promotion when accepted Goal persistence is not required", () => {
    expect(() => validateArtifactPersistence("not_required", withPromotion))
      .toThrow("does not require artifact persistence");
    expect(() => validateArtifactPersistence("not_required", noPromotion)).not.toThrow();
  });
});
