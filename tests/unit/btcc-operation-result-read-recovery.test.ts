import { afterEach, expect, test } from "bun:test";
import type { OperationRequest } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  cleanupProductionOperationsFixtures,
  createFixture,
  createRuntime,
  envelope,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

test("an invalid result selector returns a correctable operation result", async () => {
  const fixture = createFixture();
  const runtime = createRuntime(fixture);
  const sourceRequest: Extract<OperationRequest, { kind: "observe" }> = {
    requestId: "observe-source",
    publicTitle: "Test operation",
    kind: "observe",
    capabilityRef: "web_read",
    scopeRef: "public-web",
    input: { url: "https://example.com" },
  };
  const source = await runtime.operations.perform({
    request: sourceRequest,
    envelope: envelope(),
  });
  if (!source.readScopeRef) {
    throw new Error("source observation did not expose a durable result scope");
  }
  const invalidRead: Extract<OperationRequest, { kind: "observe" }> = {
    requestId: "read-missing-pointer",
    publicTitle: "Test operation",
    kind: "observe",
    capabilityRef: "read_operation_result",
    scopeRef: source.readScopeRef,
    input: { selector: "json_pointer", pointer: "/request/input/missing" },
  };

  const result = await runtime.operations.perform({
    request: invalidRead,
    envelope: envelope(),
  });

  expect(result.outcome).toBe("operation_rejected");
  expect(result.preview).toContain("operation_result_read_invalid");
  expect(result.preview).toContain("JSON pointer does not resolve");
});
