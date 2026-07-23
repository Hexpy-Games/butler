import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProductionSelectedModel } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/index.ts";
import {
  cleanupProductionOperationsFixtures,
  createDirectoryFixture,
  createRuntime,
  provisionWorkspace,
  workspaceEnvelope,
  workspaceObservationRequest,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";
import {
  actualIdentity,
  capabilityCatalog,
  emptyContextResolver,
  guidanceReader,
  phaseEnvelope,
  promptRunner,
} from "./support/btcc-production-selected-model-fixtures.ts";

afterEach(cleanupProductionOperationsFixtures);

describe("artifact workspace observation", () => {
  test("reads the current isolated bytes after a Task write", async () => {
    const fixture = createDirectoryFixture();
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const changed = "current isolated bytes\n";
    const phase = workspaceEnvelope(provision);

    await runtime.operations.perform({
      request: workspaceRequest(
        provision.workspace.ref,
        fixture.targetPath,
        changed,
        "guide.md",
      ),
      envelope: phase,
    });
    const observed = await runtime.operations.perform({
      request: workspaceObservationRequest(provision.workspace.ref, "guide.md"),
      envelope: phase,
    });

    expect(JSON.parse(observed.content ?? observed.preview ?? "")).toEqual({
      content: changed,
      path: "guide.md",
    });
    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8")).toBe(fixture.original);
    expect(observed.artifactRevisionRef).toBeUndefined();
  });
});

test("binds the current workspace identity outside model-authored bytes", async () => {
  const workspaceRef = { id: "workspace-current", sha256: "workspace-current-sha" };
  const model = createProductionSelectedModel({
    context: emptyContextResolver(),
    capabilities: capabilityCatalog([{
      capabilityRef: "read_file",
      name: "read_file",
      description: "Read current isolated bytes.",
      operationKinds: ["workspace_artifact_observation"],
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }]),
    guidance: guidanceReader(),
    promptRunner: promptRunner(async () => ({
      carrier: {
        kind: "operation_requests",
        requests: [{
          requestId: "read-current",
          kind: "workspace_artifact_observation",
          capabilityRef: "read_file",
          input: { path: "src/sample.ts" },
        }],
      },
      actualIdentity: actualIdentity(),
    })),
  });
  const phase = phaseEnvelope({ emptyContext: true });
  phase.operationAuthority = {
    observationScopeRefs: [],
    mutation: {
      kind: "workspace_only",
      workspaceRef,
      operationRoot: { kind: "directory", relativeTarget: "." },
      mutationScope: { kind: "read_only" },
    },
  };

  const result = await model.runRound(phase);

  expect(result.kind).toBe("operation_requests");
  if (result.kind !== "operation_requests") throw new Error("expected operation requests");
  expect(result.requests[0]).toMatchObject({
    kind: "workspace_artifact_observation",
    workspaceRef,
    input: { path: "src/sample.ts" },
  });
});
