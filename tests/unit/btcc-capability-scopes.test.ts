import { describe, expect, test } from "bun:test";
import { resolveAvailableCapabilities } from "../../packages/butler-agent/src/agent/btcc/infrastructure/model/available-capabilities.ts";

describe("BTCC capability scopes", () => {
  test("fails closed when an observe capability declares no scope ownership", async () => {
    const capabilities = await resolveAvailableCapabilities({
      authority: {
        observationScopeRefs: ["workspace:/tmp/project", "ledger:sandy", "web:current"],
        mutation: { kind: "forbidden" },
      },
      catalog: {
        list: () => [{
          capabilityRef: "unscoped",
          name: "unscoped",
          description: "Must not inherit every admitted scope.",
          operationKinds: ["observe"],
          inputSchema: { type: "object" },
        }],
      },
    });

    expect(capabilities).toEqual([]);
  });

  test("projects only scopes owned by the capability domain", async () => {
    const capabilities = await resolveAvailableCapabilities({
      authority: {
        observationScopeRefs: ["workspace:/tmp/project", "ledger:sandy", "web:current"],
        mutation: { kind: "forbidden" },
      },
      catalog: {
        list: () => [{
          capabilityRef: "ledger-read",
          name: "ledger_read",
          description: "Read the bound Project Ledger.",
          operationKinds: ["observe"],
          observationScopeKinds: ["ledger"],
          inputSchema: { type: "object" },
        }],
      },
    });

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]?.observationScopeRefs).toEqual(["ledger:sandy"]);
  });
});
