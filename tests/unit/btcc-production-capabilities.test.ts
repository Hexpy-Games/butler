import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionToolRuntime } from "../../packages/butler-agent/src/agent/composition/production-btcc/index.ts";
import { createProductionOperationRuntime } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/operations/index.ts";
import { OperationRejectedError, type OperationRequest } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  envelope,
  provisionWorkspace,
  workspaceEnvelope,
} from "./support/btcc-production-operations-fixture.ts";
import { loadProjectLedgerCore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("production BTCC capabilities", () => {
  test("atomically applies an admitted Project Ledger external effect", async () => {
    const root = fixtureRoot();
    const projectRoot = join(root, "project-ledger", "projects", "sandy");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "project.json"), JSON.stringify({
      schema: "project-ledger.project.v1",
      id: "sandy",
      name: "Sandy",
      status: "active",
    }));
    writeFileSync(join(projectRoot, "ledger.jsonl"), "");
    const core = await loadProjectLedgerCore();
    core.createRecord(projectRoot, {
      kind: "report",
      id: "REPORT-SANDY",
      title: "Sandy report",
      status: "active",
      body: "Before",
    });
    const tools = createProductionToolRuntime({
      butlerHome: root,
      butlerData: root,
      appMessageDbPath: join(root, "app.sqlite"),
      resolveProjectLedgerRoot(projectRef) {
        expect(projectRef).toBe("sandy");
        return projectRoot;
      },
    });
    const runtime = createProductionOperationRuntime({
      butlerData: root,
      async resolveTargetScope() {
        return { targetPath: root };
      },
      ...tools,
    });
    const effectIntentRef = { id: "effect-ledger", sha256: "effect-ledger-sha" };
    const request: Extract<OperationRequest, { kind: "external_effect" }> = {
      requestId: "update-sandy-report",
      publicTitle: "Update Sandy project report",
      kind: "external_effect",
      capabilityRef: "project_ledger_update",
      effectIntentRef,
      occurrenceKey: "reconcile-sandy-ledger",
      targetScopeRef: "ledger:sandy",
      input: {
        updates: [{
          id: "REPORT-SANDY",
          kind: "report",
          body: "After",
          reason: "Reconciled",
        }],
      },
    };
    const phase = envelope({ currentEffectIntent: { ref: effectIntentRef } });
    phase.context.projectRef = "sandy";
    phase.operationAuthority = {
      observationScopeRefs: ["ledger:sandy"],
      mutation: {
        kind: "external_effect_only",
        effectIntentRef,
        occurrenceKey: request.occurrenceKey,
        targetScopeRef: request.targetScopeRef,
      },
    };

    const result = await runtime.operations.perform({ request, envelope: phase });
    expect(result).toMatchObject({
      outcome: "external_effect_applied",
      effectReceiptRef: expect.any(Object),
      targetSnapshotRef: expect.any(Object),
    });
    const record = core.resolveRecord(projectRoot, { kind: "report", id: "REPORT-SANDY" });
    expect(core.readRecordBody(record.filePath)).toBe("After");
    expect(core.readRecordData(record.filePath)?.reason).toBe("Reconciled");

    const replay = await runtime.operations.perform({ request, envelope: phase });
    expect(replay.resultRef).toEqual(result.resultRef);

    const resumedPhase = {
      ...phase,
      binding: { ...phase.binding, checkpointRevision: phase.binding.checkpointRevision + 1 },
    };
    const resumed = await runtime.operations.perform({ request, envelope: resumedPhase });
    expect(resumed.targetSnapshotRef).toEqual(result.targetSnapshotRef);

    const conflictingRequest = {
      ...request,
      requestId: "change-sandy-report-again",
      input: {
        updates: [{ id: "REPORT-SANDY", kind: "report", body: "Different" }],
      },
    };
    await expect(runtime.operations.perform({
      request: conflictingRequest,
      envelope: {
        ...resumedPhase,
        binding: {
          ...resumedPhase.binding,
          checkpointRevision: resumedPhase.binding.checkpointRevision + 1,
        },
      },
    })).rejects.toThrow("already has different content");
    expect(core.readRecordBody(record.filePath)).toBe("After");
  });

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
      publicTitle: "Test operation",
      kind: "workspace_artifact_action",
      capabilityRef: "run_command",
      workspaceRef: provision.workspace.ref,
      relativeTarget: ".",
      input: {
        command: `node -e 'process.stdout.write("${prefix}" + "x".repeat(120000) + "TAIL")'`,
        state_effect: "read_only",
      },
    };
    const result = await runtime.operations.perform({
      request,
      envelope: workspaceEnvelope(provision, { kind: "read_only" }),
    });

    expect(result.byteLength).toBeGreaterThan(120_000);
    expect(result.preview).toContain(prefix);
    expect(result.content).toBeUndefined();
    expect(result.executionSummary).toEqual({
      kind: "command_execution",
      exitCode: 0,
      timedOut: false,
      signal: null,
    });
    const read = await runtime.operations.perform({
      request: {
        requestId: "read-command-prefix",
        publicTitle: "Test operation",
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
      publicTitle: "Test operation",
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
      publicTitle: "Test operation",
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

  test("classifies model-authored Review input errors as operation rejection", () => {
    const root = fixtureRoot();
    const runtime = createProductionToolRuntime({
      butlerHome: root,
      butlerData: root,
      appMessageDbPath: join(root, "app.sqlite"),
    });
    const request: Extract<OperationRequest, { kind: "review_validation" }> = {
      requestId: "invalid-review-effect",
      publicTitle: "Validate review source",
      kind: "review_validation",
      capabilityRef: "run_command",
      reviewSourceRef: { id: "review-source", sha256: "review-source-sha" },
      input: { command: "npm test", state_effect: "read_only" },
    };

    expect(() => runtime.validateOperationInput({
      envelope: envelope(),
      request,
      args: request.input,
    })).toThrow(OperationRejectedError);
  });

  test("admits a validation command in a Task-owned workspace", () => {
    const root = fixtureRoot();
    const runtime = createProductionToolRuntime({
      butlerHome: root,
      butlerData: root,
      appMessageDbPath: join(root, "app.sqlite"),
    });
    const request: Extract<OperationRequest, { kind: "workspace_artifact_action" }> = {
      requestId: "task-validation",
      publicTitle: "Validate the Task workspace",
      kind: "workspace_artifact_action",
      capabilityRef: "run_command",
      workspaceRef: { id: "workspace-1", sha256: "workspace-hash" },
      relativeTarget: ".",
      input: { command: "npm test", state_effect: "validation" },
    };

    expect(() => runtime.validateOperationInput({
      envelope: envelope(),
      request,
      args: request.input,
    })).not.toThrow();
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
      publicTitle: "Test operation",
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
      publicTitle: "Test operation",
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
