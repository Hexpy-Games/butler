import { existsSync, linkSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  contentRef,
  digest,
  requireRecord,
  type ObservationResult,
  type PhaseEnvelope,
} from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import {
  assertActive,
  operationContent,
  sameRef,
} from "./operation-helpers.ts";
import {
  captureWorkspaceSnapshot,
  materializeSnapshot,
  removeOwnedRoot,
  snapshotSha256,
  workspaceContentRoot,
} from "./target-snapshot.ts";
import { operationRoundScope } from "../../core/operation-identity.ts";

export async function performReviewValidation(input: {
  request: Extract<import("../../core/index.ts").OperationRequest, { kind: "review_validation" }>;
  envelope: PhaseEnvelope;
  options: ProductionOperationRuntimeOptions;
  store: ArtifactStore;
  signal?: AbortSignal;
}): Promise<ObservationResult> {
  assertActive(input.signal);
  const source = resolveReviewSource(input.envelope, input.request.reviewSourceRef);
  const snapshotValue = input.store.loadSnapshot(source.targetSnapshotRef.id);
  if (!snapshotValue || !sameRef(snapshotValue.ref, source.targetSnapshotRef)) {
    throw new Error("BTCC Review source has no exact durable snapshot");
  }
  const workspace = input.store.loadWorkspaceByRef(source.workspaceRef.id);
  if (!workspace || !sameRef(workspace.provision.workspace.ref, source.workspaceRef)) {
    throw new Error("BTCC Review source references an unknown artifact workspace");
  }
  const root = join(
    input.options.butlerData,
    "runtime",
    "btcc-artifacts",
    "review-overlays",
    digest(`${operationRoundScope(input.envelope.binding)}\0${input.request.requestId}`),
  );
  if (existsSync(root)) removeOwnedRoot(root);
  mkdirSync(root, { recursive: true });
  const contentRoot = workspaceContentRoot(root);
  materializeSnapshot(snapshotValue, contentRoot);
  projectLogicalFileTarget(input.envelope, workspace, contentRoot);
  const before = captureWorkspaceSnapshot(
    root, snapshotValue.targetKind, snapshotValue.targetState,
  );
  if (snapshotSha256(before) !== snapshotSha256(snapshotValue)) {
    removeOwnedRoot(root);
    throw new Error("BTCC Review overlay does not match its immutable source");
  }
  try {
    const args = input.request.input;
    input.options.validateOperationInput({
      envelope: input.envelope,
      request: input.request,
      args,
    });
    const execute = input.options.createIsolatedValidationExecutor({
      workspacePath: workspaceContentRoot(root),
      envelope: input.envelope,
      request: input.request,
    });
    const output = await execute({
      name: input.request.capabilityRef,
      args,
      rawArguments: JSON.stringify(input.request.input),
      signal: input.signal,
    });
    assertActive(input.signal);
    const after = captureWorkspaceSnapshot(
      root, snapshotValue.targetKind, snapshotValue.targetState,
    );
    const payload = operationContent(output);
    const validationReceiptRef = contentRef("review-validation-receipt", {
      requestId: input.request.requestId,
      reviewSourceRef: input.request.reviewSourceRef,
      beforeSnapshotRef: before.ref,
      afterSnapshotRef: after.ref,
      output: payload.payloadSource
        ? {
            sha256: payload.payloadSource.sha256,
            byteLength: payload.payloadSource.byteLength,
          }
        : payload.content,
    });
    return {
      requestId: input.request.requestId,
      outcome: "review_validated",
      observationRef: contentRef("review-validation-observation", {
        requestId: input.request.requestId,
        validationReceiptRef,
      }),
      validationReceiptRef,
      content: payload.content,
      ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
      ...(payload.executionSummary ? { executionSummary: payload.executionSummary } : {}),
    };
  } finally {
    removeOwnedRoot(root);
  }
}

function resolveReviewSource(
  envelope: PhaseEnvelope,
  expectedRef: { id: string; sha256: string },
): {
  targetSnapshotRef: { id: string; sha256: string };
  workspaceRef: { id: string; sha256: string };
} {
  const state = requireRecord(envelope.context.stateInput, "Task Review state");
  const resultCandidate = requireRecord(state.resultCandidate, "Task Review ResultCandidate");
  const result = requireRecord(resultCandidate.result, "Task Review result");
  const revision = requireRecord(result.workspaceRevision, "Task Review workspace revision");
  const ref = requireRef(revision.ref, "Task Review workspace revision ref");
  if (!sameRef(ref, expectedRef)) throw new Error("BTCC Review request changed its source revision");
  return {
    targetSnapshotRef: requireRef(revision.targetSnapshotRef, "Review target snapshot"),
    workspaceRef: requireRef(revision.workspaceRef, "Review workspace"),
  };
}

function projectLogicalFileTarget(
  envelope: PhaseEnvelope,
  workspace: NonNullable<ReturnType<ArtifactStore["loadWorkspaceByRef"]>>,
  contentRoot: string,
): void {
  if (workspace.targetKind !== "file") return;
  const internalTarget = join(contentRoot, "target");
  if (!existsSync(internalTarget)) return;
  const admittedRoot = admittedWorkspaceRoots(envelope)
    .filter((root) => containedRelativePath(root, workspace.targetPath) !== null)
    .sort((left, right) => right.length - left.length)[0];
  if (!admittedRoot) {
    throw new Error("BTCC Review cannot project its logical target outside admitted workspace roots");
  }
  const logicalPath = containedRelativePath(admittedRoot, workspace.targetPath);
  if (!logicalPath || logicalPath === "target") return;
  const projectedTarget = resolve(contentRoot, logicalPath);
  if (containedRelativePath(contentRoot, projectedTarget) === null) {
    throw new Error("BTCC Review logical target escapes its owned overlay");
  }
  mkdirSync(dirname(projectedTarget), { recursive: true });
  linkSync(internalTarget, projectedTarget);
}

function admittedWorkspaceRoots(envelope: PhaseEnvelope): string[] {
  return envelope.context.baselineObservationScopeRefs
    .filter((scope) => scope.startsWith("workspace:"))
    .map((scope) => canonicalPath(scope.slice("workspace:".length)));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function containedRelativePath(root: string, target: string): string | null {
  const child = relative(resolve(root), resolve(target));
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
    ? child
    : null;
}

function requireRef(value: unknown, label: string): { id: string; sha256: string } {
  const ref = requireRecord(value, label);
  if (typeof ref.id !== "string" || typeof ref.sha256 !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return { id: ref.id, sha256: ref.sha256 };
}
