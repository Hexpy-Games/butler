import { describe, expect, test } from "bun:test";
import { resolveAvailableCapabilities } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/available-capabilities.ts";
import { createProductionCapabilityCatalog } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";

describe("BTCC Turn-local effects", () => {
  test("admits only the bounded onboarding capability", async () => {
    const capabilities = await resolveAvailableCapabilities({
      catalog: createProductionCapabilityCatalog(),
      authority: {
        observationScopeRefs: [],
        mutation: {
          kind: "turn_local_effect_only",
          capabilities: [{
            capabilityRef: "update_onboarding_profile",
            inputSchema: { type: "object" },
          }],
        },
      },
    });

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({
      capabilityRef: "update_onboarding_profile",
      operationKind: "turn_local_effect",
    });
  });
});
