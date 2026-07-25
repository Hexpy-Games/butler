import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { contentRef } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  cleanupProductionOperationsFixtures,
  createFixture,
  createRuntime,
  envelope,
  provisionWorkspace,
  reviewRequest,
  workspaceEnvelope,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

test("Review exposes immutable file bytes through the Task logical path", async () => {
  const fixture = createFixture();
  const runtime = createRuntime(fixture);
  const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
  const applied = await runtime.operations.perform({
    request: workspaceRequest(provision.workspace.ref, fixture.targetPath, "reviewed bytes\n"),
    envelope: workspaceEnvelope(provision),
  });
  const reviewSourceRef = contentRef("workspace-revision", {
    targetSnapshotRef: applied.targetSnapshotRef,
  });
  let reviewed = "";
  fixture.validate = ({ workspacePath }) => {
    reviewed = readFileSync(join(workspacePath, basename(fixture.targetPath)), "utf8");
    return { valid: true };
  };
  const reviewEnvelope = envelope({
    reviewValidationSource: {
      ref: reviewSourceRef,
      workspaceRef: provision.workspace.ref,
      targetSnapshotRef: applied.targetSnapshotRef,
    },
  });
  reviewEnvelope.context.baselineObservationScopeRefs = [`workspace:${fixture.root}`];

  const result = await runtime.operations.perform({
    request: reviewRequest(reviewSourceRef),
    envelope: reviewEnvelope,
  });
  expect(result.outcome).toBe("review_validated");
  expect(reviewed).toBe("reviewed bytes\n");
});
