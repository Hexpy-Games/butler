import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionToolRuntime } from "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
import type { OperationRequest } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { envelope } from "./support/btcc-production-operations-fixture.ts";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("production BTCC capabilities", () => {
  test("writes only the declared artifact target through the BTCC-owned registry", async () => {
    const workspacePath = fixtureRoot();
    const runtime = createProductionToolRuntime({
      butlerHome: workspacePath,
      butlerData: workspacePath,
      appMessageDbPath: join(workspacePath, "app.sqlite"),
    });
    const request: Extract<OperationRequest, { kind: "workspace_artifact_action" }> = {
      requestId: "write-1",
      kind: "workspace_artifact_action",
      capabilityRef: "write_file",
      workspaceRef: { id: "workspace-1", sha256: "workspace-hash" },
      relativeTarget: "result.txt",
      input: { path: "result.txt", content: "clean BTCC\n", overwrite: false },
    };
    const args = request.input;

    runtime.validateOperationInput({ envelope: envelope(), request, args });
    const execute = runtime.createWorkspaceToolExecutor({
      workspacePath,
      envelope: envelope(),
      request,
    });
    await execute({ name: "write_file", args, rawArguments: JSON.stringify(request.input) });

    expect(readFileSync(join(workspacePath, "result.txt"), "utf8")).toBe("clean BTCC\n");
    expect(() => runtime.validateOperationInput({
      envelope: envelope(),
      request,
      args: { ...args, path: "other.txt" },
    })).toThrow("must equal the planned relative target");
  });

  test("rejects a capability whose declared operation class does not match", () => {
    const workspacePath = fixtureRoot();
    const runtime = createProductionToolRuntime({
      butlerHome: workspacePath,
      butlerData: workspacePath,
      appMessageDbPath: join(workspacePath, "app.sqlite"),
    });
    const request: Extract<OperationRequest, { kind: "workspace_artifact_action" }> = {
      requestId: "read-as-write",
      kind: "workspace_artifact_action",
      capabilityRef: "read_file",
      workspaceRef: { id: "workspace-1", sha256: "workspace-hash" },
      relativeTarget: "result.txt",
      input: { path: "result.txt" },
    };

    expect(() => runtime.validateOperationInput({
      envelope: envelope(),
      request,
      args: { path: "result.txt" },
    })).toThrow("unavailable for workspace_artifact_action");
  });

  test("reads only the canonical Ledger bound by the observation scope", async () => {
    const root = fixtureRoot();
    const projectRoot = join(root, "project-ledger", "projects", "sandy");
    const specPath = join(projectRoot, "specs", "trust.md");
    mkdirSync(join(projectRoot, "index"), { recursive: true });
    mkdirSync(join(projectRoot, "specs"), { recursive: true });
    writeFileSync(specPath, "# Trust profiling\n\nPreserve Sandy's voice.\n");
    writeFileSync(join(projectRoot, "index", "project.json"), JSON.stringify({
      project: { id: "sandy", name: "Sandy" },
      records: [{
        id: "SPEC-SANDY-TRUST",
        kind: "spec",
        title: "Trust profiling",
        status: "specified",
        path: "project-ledger/projects/sandy/specs/trust.md",
      }],
      issues: [],
    }));
    const runtime = createProductionToolRuntime({
      butlerHome: root,
      butlerData: root,
      appMessageDbPath: join(root, "app.sqlite"),
      resolveProjectLedgerRoot(projectRef) {
        expect(projectRef).toBe("sandy");
        return projectRoot;
      },
    });
    const request: Extract<OperationRequest, { kind: "observe" }> = {
      requestId: "ledger-read-1",
      kind: "observe",
      capabilityRef: "project_ledger_read",
      scopeRef: "ledger:sandy",
      input: { record_ids: ["SPEC-SANDY-TRUST"], include_body: true },
    };
    const execute = runtime.createToolExecutor({ envelope: envelope(), request });

    const result = await execute({
      name: "project_ledger_read",
      args: request.input,
      rawArguments: JSON.stringify(request.input),
    });

    expect(result).toMatchObject({
      projectId: "sandy",
      available: true,
      records: [{ id: "SPEC-SANDY-TRUST", kind: "spec" }],
    });
    expect(JSON.stringify(result)).toContain("Preserve Sandy's voice");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "btcc-capabilities-"));
  roots.push(root);
  return root;
}
