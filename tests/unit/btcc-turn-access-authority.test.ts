import { afterEach, describe, expect, test } from "bun:test";
import {
  assertTurnAccessAllowsOperation,
} from "../../packages/butler-agent/src/agent/btcc/core/operation-access.ts";
import type { OperationRequest } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  cleanupProductionOperationsFixtures,
  createDirectoryFixture,
  createRuntime,
  envelope,
  provisionWorkspace,
  workspaceEnvelope,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

describe("BTCC turn access authority", () => {
  test("rejects a workspace write before dispatch in read-only mode", async () => {
    const fixture = createDirectoryFixture();
    let dispatched = false;
    fixture.workspace = () => {
      dispatched = true;
      return { changed: true };
    };
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const phase = workspaceEnvelope(provision);
    phase.modelSelection.controls = { accessMode: "read_only" };

    const result = await runtime.operations.perform({
      request: workspaceRequest(
        provision.workspace.ref,
        fixture.targetPath,
        "forbidden",
        "guide.md",
      ),
      envelope: phase,
    });

    expect(result.outcome).toBe("operation_rejected");
    expect(result.content ?? result.preview).toContain("read_only_access_mutation_denied");
    expect(dispatched).toBe(false);
  });

  test("requires approval for every persistent mutation in ask-first mode", () => {
    const phase = envelope();
    phase.modelSelection.controls = { accessMode: "ask_first" };
    for (const request of persistentMutations()) {
      expect(() => assertTurnAccessAllowsOperation(phase, request))
        .toThrow("durable user approval");
    }
  });

  test("allows observations in every Composer mode", () => {
    const request: Extract<OperationRequest, { kind: "observe" }> = {
      requestId: "inspect-workspace",
      publicTitle: "Inspect workspace",
      kind: "observe",
      capabilityRef: "run_command",
      scopeRef: "workspace:/project",
      input: { command: "git status --short", state_effect: "read_only" },
    };
    for (const accessMode of ["read_only", "ask_first", "full_access"] as const) {
      const phase = envelope();
      phase.modelSelection.controls = { accessMode };
      expect(() => assertTurnAccessAllowsOperation(phase, request)).not.toThrow();
    }
  });
});

function persistentMutations(): OperationRequest[] {
  const ref = { id: "ref", sha256: "sha" };
  return [{
    requestId: "write",
    publicTitle: "Write workspace",
    kind: "workspace_artifact_action",
    capabilityRef: "write_file",
    workspaceRef: ref,
    relativeTarget: "result.txt",
    input: { path: "result.txt", content: "changed" },
  }, {
    requestId: "command",
    publicTitle: "Run mutation",
    kind: "workspace_artifact_action",
    capabilityRef: "run_command",
    workspaceRef: ref,
    relativeTarget: ".",
    input: { command: "touch changed", state_effect: "mutation" },
  }, {
    requestId: "effect",
    publicTitle: "Change external target",
    kind: "external_effect",
    capabilityRef: "project_ledger_update",
    effectIntentRef: ref,
    occurrenceKey: "effect-1",
    targetScopeRef: "ledger:project",
    input: {},
  }, {
    requestId: "promotion",
    publicTitle: "Promote candidate",
    kind: "repository_promotion",
    capabilityRef: "promote_reviewed_candidate",
    authorizationRef: ref,
    candidateRef: ref,
    resolutionRef: ref,
    baselineRef: ref,
    finalSnapshotRef: ref,
    input: {},
  }];
}
