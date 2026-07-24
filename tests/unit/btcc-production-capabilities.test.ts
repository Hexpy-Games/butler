import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionToolRuntime } from "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
import { createProductionOperationRuntime } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operations/index.ts";
import type { OperationRequest } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  envelope,
  provisionWorkspace,
  workspaceEnvelope,
} from "./support/btcc-production-operations-fixture.ts";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("production BTCC capabilities", () => {
  test("spools complete command output before projecting it", async () => {
    const root = fixtureRoot();
    const targetPath = join(root, "repository");
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "README.md"), "baseline\n");
    const tools = createProductionToolRuntime({
      butlerHome: root,
      butlerData: root,
      appMessageDbPath: join(root, "app.sqlite"),
    });
    const runtime = createProductionOperationRuntime({
      butlerData: root,
      async resolveTargetScope() {
        return { targetPath };
      },
      ...tools,
    });
    const provision = await provisionWorkspace(runtime.artifacts, targetPath);
    const prefix = "PRESERVE-COMMAND-PREFIX";
    const request: Extract<OperationRequest, { kind: "workspace_artifact_action" }> = {
      requestId: "command-large-output",
      kind: "workspace_artifact_action",
      capabilityRef: "run_command",
      workspaceRef: provision.workspace.ref,
      relativeTarget: ".",
      input: {
        command: `node -e 'process.stdout.write("${prefix}" + "x".repeat(120000) + "TAIL")'`,
      },
    };
    const result = await runtime.operations.perform({
      request,
      envelope: workspaceEnvelope(provision, { kind: "read_only" }),
    });

    expect(result.byteLength).toBeGreaterThan(120_000);
    expect(result.preview).toContain(prefix);
    expect(result.content).toBeUndefined();
    const read = await runtime.operations.perform({
      request: {
        requestId: "read-command-prefix",
        kind: "observe",
        capabilityRef: "read_operation_result",
        scopeRef: result.readScopeRef!,
        input: { selector: "search", query: prefix, max_matches: 1 },
      },
      envelope: workspaceEnvelope(provision, { kind: "read_only" }),
    });
    expect(read.view?.content).toContain(prefix);
  });

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
    mkdirSync(join(projectRoot, "specs"), { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), JSON.stringify({
      schema: "project-ledger.project.v1",
      id: "sandy",
      name: "Sandy",
      status: "active",
    }));
    writeFileSync(join(projectRoot, "ledger.jsonl"), "");
    writeFileSync(specPath, [
      "---",
      'schema: "project-ledger.spec.v1"',
      'kind: "spec"',
      'id: "SPEC-SANDY-TRUST"',
      'title: "Trust profiling"',
      'status: "specified"',
      "---",
      "",
      "# Trust profiling",
      "",
      "Preserve Sandy's voice.",
      "",
    ].join("\n"));
    mkdirSync(join(projectRoot, "references"), { recursive: true });
    writeFileSync(join(projectRoot, "references", "trust-shadow.md"), [
      "---",
      'schema: "project-ledger.reference.v1"',
      'kind: "reference"',
      'id: "SPEC-SANDY-TRUST"',
      'title: "Normalized trust record"',
      'status: "active"',
      "---",
      "",
      "Internal normalized duplicate.",
      "",
    ].join("\n"));
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

    expect(() => runtime.validateOperationInput({
      envelope: envelope(),
      request: { ...request, input: { kinds: ["Spec"] } },
      args: { kinds: ["Spec"] },
    })).toThrow();
    runtime.validateOperationInput({
      envelope: envelope(),
      request: { ...request, input: { kinds: ["spec"] } },
      args: { kinds: ["spec"] },
    });

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
    expect((result as { records: unknown[] }).records).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("Preserve Sandy's voice");
    expect(JSON.stringify(result)).not.toContain("Internal normalized duplicate");

    const searched = await execute({
      name: "project_ledger_read",
      args: {
        kinds: ["spec"],
        query: "unmatched architecture Sandy voice",
        include_body: false,
      },
      rawArguments: JSON.stringify({
        kinds: ["spec"],
        query: "unmatched architecture Sandy voice",
        include_body: false,
      }),
    });
    expect((searched as { records: unknown[] }).records).toContainEqual(
      expect.objectContaining({ id: "SPEC-SANDY-TRUST", kind: "spec" }),
    );
    expect(JSON.stringify(searched)).not.toContain("Preserve Sandy's voice");
    expect((searched as { records: Array<{ kind: string }> }).records)
      .not.toContainEqual(expect.objectContaining({ kind: "reference" }));
    const normalized = await execute({
      name: "project_ledger_read",
      args: {
        kinds: ["reference"],
        record_ids: ["SPEC-SANDY-TRUST"],
        include_body: true,
      },
      rawArguments: JSON.stringify({
        kinds: ["reference"],
        record_ids: ["SPEC-SANDY-TRUST"],
        include_body: true,
      }),
    });
    expect(normalized).toMatchObject({
      records: [{ id: "SPEC-SANDY-TRUST", kind: "reference" }],
    });
    expect(JSON.stringify(normalized)).toContain("Internal normalized duplicate");
    await expect(execute({
      name: "project_ledger_read",
      args: { query: "Sandy voice", include_body: true },
      rawArguments: JSON.stringify({ query: "Sandy voice", include_body: true }),
    })).rejects.toThrow("require explicit record_ids");

    const reviewRequest: Extract<OperationRequest, { kind: "review_validation" }> = {
      requestId: "ledger-review-1",
      kind: "review_validation",
      capabilityRef: "project_ledger_read",
      reviewSourceRef: { id: "review-source", sha256: "review-source-sha" },
      input: { record_ids: ["SPEC-SANDY-TRUST"], include_body: true },
    };
    const reviewEnvelope = envelope();
    reviewEnvelope.context.projectRef = "sandy";
    const review = runtime.createIsolatedValidationExecutor({
      workspacePath: root,
      envelope: reviewEnvelope,
      request: reviewRequest,
    });
    expect(await review({
      name: "project_ledger_read",
      args: reviewRequest.input,
      rawArguments: JSON.stringify(reviewRequest.input),
    })).toMatchObject({
      projectId: "sandy",
      records: [{ id: "SPEC-SANDY-TRUST", kind: "spec" }],
    });
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "btcc-capabilities-"));
  roots.push(root);
  return root;
}
