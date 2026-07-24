import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentRef,
  type OperationRequest,
  type PhaseEnvelope,
} from "../../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  createProductionOperationRuntime,
  type ProductionOperationRuntimeOptions,
} from "../../../packages/butler-agent/src/agent/btcc/infrastructure/operations/index.ts";
import { ArtifactStore } from "../../../packages/butler-agent/src/agent/btcc/infrastructure/operations/artifact-store.ts";
import { ProductionArtifactWorkspaceRuntime } from "../../../packages/butler-agent/src/agent/btcc/infrastructure/operations/artifact-workspace-runtime.ts";
import {
  createOperationExecutor,
  type OperationRuntimeBoundary,
} from "../../../packages/butler-agent/src/agent/btcc/infrastructure/operations/production-operation-runtime.ts";

const temporaryRoots: string[] = [];

export type ProductionOperationsFixture = {
  root: string;
  dataRoot: string;
  targetPath: string;
  original: string;
  observe?: (call: { name: string; args: Record<string, unknown>; rawArguments: string }) => unknown;
  validate?: (input: { workspacePath: string }) => unknown;
  workspace?: (call: {
    name: string;
    args: Record<string, unknown>;
    rawArguments: string;
    workspacePath: string;
  }) => unknown;
};

export function cleanupProductionOperationsFixtures(): void {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function createFixture(): ProductionOperationsFixture {
  const root = mkdtempSync(join(tmpdir(), "btcc-production-operations-"));
  temporaryRoots.push(root);
  const targetPath = join(root, "guide.md");
  const original = "original bytes\n";
  writeFileSync(targetPath, original);
  return { root, dataRoot: join(root, "data"), targetPath, original };
}

export function createDirectoryFixture(): ProductionOperationsFixture {
  const fixture = createFixture();
  const targetPath = join(fixture.root, "repository");
  mkdirSync(targetPath);
  writeFileSync(join(targetPath, "guide.md"), fixture.original);
  return { ...fixture, targetPath };
}

export function createAbsentDirectoryFixture(): ProductionOperationsFixture {
  const fixture = createFixture();
  rmSync(fixture.targetPath);
  return { ...fixture, targetPath: join(fixture.root, "new-target") };
}

export function createRuntime(fixture: ProductionOperationsFixture) {
  return createProductionOperationRuntime(runtimeOptions(fixture));
}

export function createFaultableRuntime(
  fixture: ProductionOperationsFixture,
  afterBoundary: (boundary: OperationRuntimeBoundary) => void,
) {
  const options = runtimeOptions(fixture);
  const store = new ArtifactStore(fixture.dataRoot);
  return {
    artifacts: new ProductionArtifactWorkspaceRuntime(options, store),
    operations: createOperationExecutor(options, store, afterBoundary),
  };
}

function runtimeOptions(
  fixture: ProductionOperationsFixture,
): ProductionOperationRuntimeOptions {
  return {
    butlerData: fixture.dataRoot,
    async resolveTargetScope() {
      return { targetPath: fixture.targetPath };
    },
    createToolExecutor() {
      return async (call) => fixture.observe?.(call) ?? { ok: true };
    },
    createWorkspaceToolExecutor({ workspacePath, request }) {
      return async (call) => {
        if (fixture.workspace) return fixture.workspace({ ...call, workspacePath });
        const destination = lstatSync(fixture.targetPath).isFile()
          ? join(workspacePath, "target")
          : join(workspacePath, request.relativeTarget);
        const content = call.args.content;
        if (typeof content !== "string") throw new Error("test workspace content is missing");
        writeFileSync(destination, content);
        return { changed: request.relativeTarget };
      };
    },
    createWorkspaceObservationExecutor({ workspacePath }) {
      return async (call) => {
        if (fixture.workspace) return fixture.workspace({ ...call, workspacePath });
        if (call.name !== "read_file") return { workspacePath };
        const path = String(call.args.path ?? "target");
        return { content: readFileSync(join(workspacePath, path), "utf8"), path };
      };
    },
    createIsolatedValidationExecutor({ workspacePath }) {
      return async () => fixture.validate?.({ workspacePath }) ?? { valid: true };
    },
    validateOperationInput() {},
  };
}

export async function provisionWorkspace(
  artifacts: ReturnType<typeof createRuntime>["artifacts"],
  targetPath: string,
) {
  return artifacts.acquireProgramWorkspace({
    turnId: "turn-1",
    turnRevision: 1,
    programId: "program-1",
    workRef: contentRef("work", { id: 1 }),
    taskRef: contentRef("task", { id: 1 }),
    attemptRef: contentRef("attempt", { id: 1 }),
    targetScopeRef: `path:${targetPath}`,
    baselinePolicy: "capture_at_workspace_provision",
  });
}

export function workspaceRequest(
  workspaceRef: { id: string; sha256: string },
  targetPath: string,
  content: string,
  relativeTarget = "target",
): Extract<OperationRequest, { kind: "workspace_artifact_action" }> {
  return {
    requestId: `workspace:${relativeTarget}:${content}`,
    kind: "workspace_artifact_action",
    capabilityRef: "write_file",
    workspaceRef,
    relativeTarget,
    input: { content },
  };
}

export function workspaceObservationRequest(
  workspaceRef: { id: string; sha256: string },
  path: string,
): Extract<OperationRequest, { kind: "workspace_artifact_observation" }> {
  return {
    requestId: `workspace-observation:${path}`,
    kind: "workspace_artifact_observation",
    capabilityRef: "read_file",
    workspaceRef,
    input: { path },
  };
}

export function reviewRequest(
  reviewSourceRef: { id: string; sha256: string },
): Extract<OperationRequest, { kind: "review_validation" }> {
  return {
    requestId: "review-1",
    kind: "review_validation",
    capabilityRef: "run_command",
    reviewSourceRef,
    input: { command: "check" },
  };
}

export function promotionRequest(
  provision: Awaited<ReturnType<typeof provisionWorkspace>>,
  finalSnapshotRef: { id: string; sha256: string },
) {
  const refs = {
    authorizationRef: contentRef("promotion-authorization", { id: 1 }),
    candidateRef: contentRef("reviewed-promotion-candidate", { id: 1 }),
    resolutionRef: contentRef("promotion-resolution", { id: 1 }),
    baselineRef: provision.baseline.ref,
    finalSnapshotRef,
  };
  const request: Extract<OperationRequest, { kind: "repository_promotion" }> = {
    requestId: "promotion-1",
    kind: "repository_promotion",
    capabilityRef: "repository_promotion",
    ...refs,
    input: { operation: "promote" },
  };
  return {
    request,
    envelope: envelope({
      executionTarget: {
        target: { kind: "repository_promotion", workspaceRef: provision.workspace.ref, ...refs },
      },
    }),
  };
}

export function envelope(stateInput: unknown = {}): PhaseEnvelope {
  return {
    binding: {
      turnId: "turn-1",
      turnRevision: 1,
      semanticState: "task_execution",
      checkpointId: "checkpoint-1",
      checkpointRevision: 1,
      claimId: "claim-1",
      executionFence: 1,
    },
    phase: "task_execution",
    operationSurface: "authorized",
    objective: "test production operations",
    duties: [],
    prohibitions: [],
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: {},
      controlsHash: "controls",
    },
    context: {
      originalMessageId: "message-1",
      originalMessage: "test",
      sessionId: "session-1",
      userRef: "user-1",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
      stateInput,
    },
    operationAuthority: { observationScopeRefs: [], mutation: { kind: "forbidden" } },
    operationResults: [],
    submissionSchema: {
      type: "object",
      properties: { kind: { const: "result_candidate" } },
      required: ["kind"],
      additionalProperties: false,
    },
  };
}

export function workspaceEnvelope(
  provision: Awaited<ReturnType<typeof provisionWorkspace>>,
  mutationScope: Extract<
    PhaseEnvelope["operationAuthority"]["mutation"],
    { kind: "workspace_only" }
  >["mutationScope"] = { kind: "contained_paths", writablePaths: ["."] },
): PhaseEnvelope {
  const value = envelope();
  value.operationAuthority = {
    observationScopeRefs: [],
    mutation: {
      kind: "workspace_only",
      workspaceRef: provision.workspace.ref,
      operationRoot: provision.workspace.operationRoot,
      mutationScope,
    },
  };
  return value;
}
