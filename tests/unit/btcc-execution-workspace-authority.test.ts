import { describe, expect, test } from "bun:test";
import { scopeTaskExecution } from
  "../../packages/butler-agent/src/agent/btcc/execution/scope-task-execution.ts";
import { resolveAvailableCapabilities } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/available-capabilities.ts";

const workspaceRef = { id: "workspace-current", sha256: "workspace-current-sha" };

describe("BTCC Task Execution workspace authority", () => {
  test("closes stale target observation while retaining independent scopes", async () => {
    const scoped = scopeTaskExecution({
      admittedAuthority: {
        observationScopeRefs: [
          "workspace:/project",
          "workspace:/independent",
          "web:current",
        ],
        mutation: { kind: "forbidden" },
      },
      artifactTargetScopeRef: "workspace:/project",
      target: {
        kind: "provisioned_workspace",
        provisionOutcomeRef: { id: "provision", sha256: "provision-sha" },
        workspaceRef,
        baselineRef: { id: "baseline", sha256: "baseline-sha" },
        baselineSnapshotRef: { id: "snapshot", sha256: "snapshot-sha" },
        acceptedBaseRevisionRefs: [],
        operationRoot: { kind: "directory", relativeTarget: "." },
        mutationScope: { kind: "read_only" },
      },
    });

    expect(scoped).toEqual({
      targetScopeRefs: [],
      operationAuthority: {
        observationScopeRefs: ["workspace:/independent", "web:current"],
        mutation: {
          kind: "workspace_only",
          workspaceRef,
          operationRoot: { kind: "directory", relativeTarget: "." },
          mutationScope: { kind: "read_only" },
        },
      },
    });

    const capabilities = await resolveAvailableCapabilities({
      authority: scoped.operationAuthority,
      catalog: {
        list: () => [
          {
            capabilityRef: "read-file",
            name: "read_file",
            description: "Read workspace files.",
            operationKinds: ["observe", "workspace_artifact_observation"],
            observationScopeRefs: ["workspace:/project"],
            inputSchema: { type: "object" },
          },
          {
            capabilityRef: "web-search",
            name: "web_search",
            description: "Search the web.",
            operationKinds: ["observe"],
            observationScopeKinds: ["web"],
            inputSchema: { type: "object" },
          },
        ],
      },
    });

    expect(capabilities).toHaveLength(2);
    expect(capabilities[0]).toMatchObject({
      capabilityRef: "read-file",
      operationKind: "workspace_artifact_observation",
      observationScopeRefs: [],
    });
    expect(capabilities[1]).toMatchObject({
      capabilityRef: "web-search",
      operationKind: "observe",
      observationScopeRefs: ["web:current"],
    });
  });

  test("fails instead of silently retaining baseline authority without a target scope", () => {
    expect(() => scopeTaskExecution({
      admittedAuthority: {
        observationScopeRefs: ["workspace:/project"],
        mutation: { kind: "forbidden" },
      },
      target: {
        kind: "provisioned_workspace",
        provisionOutcomeRef: { id: "provision", sha256: "provision-sha" },
        workspaceRef,
        baselineRef: { id: "baseline", sha256: "baseline-sha" },
        baselineSnapshotRef: { id: "snapshot", sha256: "snapshot-sha" },
        acceptedBaseRevisionRefs: [],
        operationRoot: { kind: "directory", relativeTarget: "." },
        mutationScope: { kind: "read_only" },
      },
    })).toThrow("missing its artifact target scope");
  });
});
