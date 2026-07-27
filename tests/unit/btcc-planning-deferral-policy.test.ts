import { describe, expect, test } from "bun:test";
import {
  applyPlanningDeferralPolicy,
  planningDeferralPolicy,
} from "../../packages/butler-agent/src/agent/btcc/planning/deferral-policy.ts";
import { literalSchema, objectSchema, type PhaseCodec } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";

describe("BTCC Planning deferred-continuation policy", () => {
  test("consumes a bound deferred blocker before initial Planning", () => {
    const policy = planningDeferralPolicy({ kind: "deferred_goal" } as never);
    const codec = applyPlanningDeferralPolicy(candidateCodec(), policy);

    expect(policy).toBe("consume_deferred_continuation");
    expect(JSON.stringify(codec.submissionSchema)).not.toContain("managed_deferral");
  });

  test("retains typed deferral for new managed work", () => {
    const policy = planningDeferralPolicy({ kind: "new_request" } as never);
    const codec = applyPlanningDeferralPolicy(candidateCodec(), policy);

    expect(policy).toBe("allow");
    expect(JSON.stringify(codec.submissionSchema)).toContain("managed_deferral");
  });
});

function candidateCodec(): PhaseCodec<{ kind: "plan_candidate" }> {
  return {
    submissionSchema: objectSchema({ kind: literalSchema("plan_candidate") }),
    decode() {
      return { kind: "plan_candidate" };
    },
  };
}
