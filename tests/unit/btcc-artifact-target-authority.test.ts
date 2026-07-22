import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  cleanupProductionOperationsFixtures,
  createFixture,
  createRuntime,
  envelope,
  provisionWorkspace,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

test("a single-file workspace rejects a second logical target before dispatch", async () => {
  const fixture = createFixture();
  const runtime = createRuntime(fixture);
  const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
  const request = workspaceRequest(
    provision.workspace.ref,
    fixture.targetPath,
    "must not replace the target\n",
    "tests/other.test.ts",
  );

  const result = await runtime.operations.perform({ request, envelope: envelope() });
  expect(result.outcome).toBe("operation_rejected");
  expect(result.content).toContain("workspace_target_mismatch");
  expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.original);
});
