import { afterEach, expect, test } from "bun:test";
import {
  cleanupProductionOperationsFixtures,
  createFixture,
  createRuntime,
  envelope,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

test("operation journals scope a model request ID to its provider round", async () => {
  const fixture = createFixture();
  fixture.observe = ({ args }) => args;
  const runtime = createRuntime(fixture);
  const first = request("initial");
  const corrected = request("corrected");

  const firstResult = await runtime.operations.perform({
    request: first,
    envelope: envelope(),
  });
  const correctedResult = await runtime.operations.perform({
    request: corrected,
    envelope: {
      ...envelope(),
      binding: { ...envelope().binding, checkpointRevision: 2 },
    },
  });

  expect(firstResult.content ?? firstResult.preview).toContain("initial");
  expect(correctedResult.content ?? correctedResult.preview).toContain("corrected");
});

function request(query: string) {
  return {
    requestId: "op-1",
    publicTitle: "Test operation",
    kind: "observe" as const,
    capabilityRef: "inspect",
    scopeRef: "workspace:test",
    input: { query },
  };
}
