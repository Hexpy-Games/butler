import { describe, expect, test } from "bun:test";
import { scopeTaskExecution } from
  "../../packages/butler-agent/src/agent/btcc/execution/scope-task-execution.ts";
import { resolveAvailableCapabilities } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/available-capabilities.ts";
import { createProductionCapabilityCatalog } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";

const workspaceRef = { id: "workspace-current", sha256: "workspace-current-sha" };

describe("BTCC Task Execution workspace authority", () => {
  test("binds one accepted external effect without widening target authority", async () => {
    const effectIntentRef = { id: "effect-1", sha256: "effect-sha" };
    const scoped = scopeTaskExecution({
      admittedAuthority: {
        observationScopeRefs: ["ledger:sandy", "web:current"],
        mutation: { kind: "forbidden" },
      },
      target: { kind: "non_artifact", targetScopeRefs: ["ledger:sandy"] },
      externalEffect: {
        ref: effectIntentRef,
        occurrenceKey: "reconcile-ledger",
        targetScopeRef: "ledger:sandy",
      },
    });

    expect(scoped.operationAuthority.mutation).toEqual({
      kind: "external_effect_only",
      effectIntentRef,
      occurrenceKey: "reconcile-ledger",
      targetScopeRef: "ledger:sandy",
    });
    const capabilities = await resolveAvailableCapabilities({
      authority: scoped.operationAuthority,
      catalog: {
        list: () => [{
          capabilityRef: "project-ledger-update",
          name: "project_ledger_update",
          description: "Update the bound Ledger.",
          operationKinds: ["external_effect"],
          inputSchema: { type: "object" },
        }],
      },
    });
    expect(capabilities).toEqual([expect.objectContaining({
      capabilityRef: "project-ledger-update",
      operationKind: "external_effect",
    })]);
  });

  test("rejects an external effect outside the current Task targets", () => {
    expect(() => scopeTaskExecution({
      admittedAuthority: {
        observationScopeRefs: ["ledger:sandy"],
        mutation: { kind: "forbidden" },
      },
      target: { kind: "non_artifact", targetScopeRefs: ["ledger:sandy"] },
      externalEffect: {
        ref: { id: "effect-1", sha256: "effect-sha" },
        occurrenceKey: "wrong-target",
        targetScopeRef: "ledger:other",
      },
    })).toThrow("outside the current Task target");
  });

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

  test("admits command validation without admitting mutation for a read-only workspace Task", async () => {
    const capabilities = await resolveAvailableCapabilities({
      authority: {
        observationScopeRefs: [],
        mutation: {
          kind: "workspace_only",
          workspaceRef,
          operationRoot: { kind: "directory", relativeTarget: "." },
          mutationScope: { kind: "read_only" },
        },
      },
      catalog: createProductionCapabilityCatalog(),
    });
    const commands = capabilities.filter(({ capabilityRef }) =>
      capabilityRef === "run_command",
    );

    expect(commands).toEqual([expect.objectContaining({
      operationKind: "workspace_artifact_observation",
    })]);
  });
});
