import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProductionCapabilityCatalog,
  createProductionToolRuntime,
} from "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
import type {
  OperationRequest,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { resolveAvailableCapabilities } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/available-capabilities.ts";
import { createProductionOperationRuntime } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operations/index.ts";
import { envelope } from "./support/btcc-production-operations-fixture.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) =>
  rmSync(root, { recursive: true, force: true })));

describe("BTCC read-only command observation", () => {
  test("is visible only as an admitted workspace observation", async () => {
    const available = await resolveAvailableCapabilities({
      authority: {
        observationScopeRefs: ["workspace:/project", "web:public"],
        mutation: { kind: "forbidden" },
      },
      catalog: createProductionCapabilityCatalog(),
    });

    expect(available.filter((item) => item.capabilityRef === "run_command"))
      .toEqual([expect.objectContaining({
        operationKind: "observe",
        observationScopeRefs: ["workspace:/project"],
      })]);
  });

  test("runs the exact five E2E observations through one structural path", async () => {
    const fixture = commandFixture();
    const runtime = fixture.runtime();
    const commands = ["pwd", "ls", "seq 1 1500", "du -sh .", "bun --version"];

    for (const [index, command] of commands.entries()) {
      const result = await runtime.operations.perform({
        request: observationRequest(`e2e-command-${index}`, fixture.scopeRef, command),
        envelope: fixture.envelope(),
      });
      expect(result.outcome).toBe("observed");
      expect(result.executionSummary).toMatchObject({
        kind: "command_execution",
        exitCode: 0,
        timedOut: false,
      });
    }
  });

  test("requires structural read_only state effect", () => {
    const fixture = commandFixture();
    const tools = fixture.tools();
    const request = observationRequest("invalid-effect", fixture.scopeRef, "pwd");

    expect(() => tools.validateOperationInput({
      envelope: fixture.envelope(),
      request,
      args: { ...request.input, state_effect: "mutation" },
    })).toThrow("command observation requires state_effect read_only");
    expect(() => tools.validateOperationInput({
      envelope: fixture.envelope(),
      request: { ...request, scopeRef: "web:public" },
      args: request.input,
    })).toThrow("command observation requires an admitted workspace scope");
  });

  test("rejects mutation state effect under admitted read-only access", () => {
    const fixture = commandFixture();
    const value = fixture.envelope();
    const workspaceRef = { id: "workspace", sha256: "workspace-sha" };
    value.operationAuthority = {
      observationScopeRefs: [],
      mutation: {
        kind: "workspace_only",
        workspaceRef,
        operationRoot: { kind: "directory", relativeTarget: "." },
        mutationScope: { kind: "contained_paths", writablePaths: ["."] },
      },
    };
    const request: Extract<OperationRequest, { kind: "workspace_artifact_action" }> = {
      requestId: "blocked-access-mode-mutation",
      publicTitle: "Mutate local workspace",
      kind: "workspace_artifact_action",
      capabilityRef: "run_command",
      workspaceRef,
      relativeTarget: ".",
      input: { command: "touch changed.txt", state_effect: "mutation" },
    };

    expect(() => fixture.tools().validateOperationInput({
      envelope: value,
      request,
      args: request.input,
    })).toThrow("read-only access mode cannot admit a mutation command");
  });

  test("macOS sandbox denies workspace mutation and network", async () => {
    if (process.platform !== "darwin") return;
    const fixture = commandFixture();
    const runtime = fixture.runtime();
    const mutation = await runtime.operations.perform({
      request: observationRequest(
        "blocked-mutation",
        fixture.scopeRef,
        "printf changed > forbidden.txt",
      ),
      envelope: fixture.envelope(),
    });
    const network = await runtime.operations.perform({
      request: observationRequest(
        "blocked-network",
        fixture.scopeRef,
        "curl -sS --max-time 2 https://example.com",
      ),
      envelope: fixture.envelope(),
    });

    expect(mutation.executionSummary?.exitCode).not.toBe(0);
    expect(existsSync(join(fixture.workspace, "forbidden.txt"))).toBe(false);
    expect(network.executionSummary?.exitCode).not.toBe(0);
  });
});

function observationRequest(
  requestId: string,
  scopeRef: string,
  command: string,
): Extract<OperationRequest, { kind: "observe" }> {
  return {
    requestId,
    publicTitle: "Inspect local workspace",
    kind: "observe",
    capabilityRef: "run_command",
    scopeRef,
    input: { command, state_effect: "read_only" },
  };
}

function commandFixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-command-observation-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "visible.txt"), "visible\n");
  const scopeRef = `workspace:${workspace}`;
  const tools = () => createProductionToolRuntime({
    butlerHome: root,
    butlerData: join(root, "data"),
    appMessageDbPath: join(root, "app.sqlite"),
  });
  const phaseEnvelope = () => {
    const value = envelope();
    value.modelSelection.controls = { accessMode: "read_only" };
    value.context.baselineObservationScopeRefs = [scopeRef];
    value.operationAuthority = {
      observationScopeRefs: [scopeRef],
      mutation: { kind: "forbidden" },
    };
    return value;
  };
  return {
    workspace,
    scopeRef,
    tools,
    envelope: phaseEnvelope,
    runtime: () => createProductionOperationRuntime({
      butlerData: join(root, "data"),
      resolveTargetScope: async () => ({ targetPath: workspace }),
      ...tools(),
    }),
  };
}
