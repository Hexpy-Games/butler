import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  contentRef,
  requireRecord,
  type ContentRef,
  type ObservationResult,
  type PhaseEnvelope,
} from "../../core/index.ts";
import { ArtifactStore, type PromotionIntent } from "./artifact-store.ts";
import { exchangeCompleteTarget } from "./atomic-target-exchange.ts";
import { assertActive, sameRef } from "./operation-helpers.ts";
import {
  captureTargetSnapshot,
  captureWorkspaceSnapshot,
  materializeCompleteTarget,
  removeOwnedRoot,
  syncCompleteTarget,
} from "./target-snapshot.ts";

type PromotionRequest = Extract<import("../../core/index.ts").OperationRequest, {
  kind: "repository_promotion";
}>;

export function performPromotion(input: {
  request: PromotionRequest;
  envelope: PhaseEnvelope;
  store: ArtifactStore;
  signal?: AbortSignal;
}): ObservationResult {
  assertActive(input.signal);
  const scopeId = input.envelope.binding.checkpointId;
  const target = resolvePromotionTarget(input.envelope, input.request);
  const workspace = input.store.loadWorkspaceByRef(target.workspaceRef.id);
  if (!workspace || !sameRef(workspace.provision.workspace.ref, target.workspaceRef)) {
    throw new Error("BTCC promotion references an unknown workspace");
  }
  if (!sameRef(workspace.provision.baseline.ref, input.request.baselineRef)) {
    throw new Error("BTCC promotion baseline does not match its workspace");
  }
  const candidate = input.store.loadSnapshot(input.request.finalSnapshotRef.id);
  if (!candidate || !sameRef(candidate.ref, input.request.finalSnapshotRef)) {
    throw new Error("BTCC promotion candidate bytes are not durable");
  }
  if (candidate.targetKind !== workspace.targetKind) {
    throw new Error("BTCC promotion candidate changed the complete target kind");
  }
  const currentWorkspace = captureWorkspaceSnapshot(workspace.workspaceRoot, workspace.targetKind);
  if (!sameRef(currentWorkspace.ref, candidate.ref)) {
    throw new Error("BTCC workspace changed after the reviewed candidate was accepted");
  }
  const targetSnapshot = captureTargetSnapshot(workspace.targetPath);
  let intent = input.store.loadPromotion(scopeId, input.request);
  if (!intent) {
    if (!sameRef(targetSnapshot.ref, workspace.baselineSnapshotRef)) {
      throw new Error("BTCC promotion target drifted from its accepted baseline");
    }
    intent = preparePromotion(input.request, workspace);
    input.store.savePromotion(scopeId, intent);
  }
  if (intent.status === "committed" && !sameRef(targetSnapshot.ref, candidate.ref)) {
    throw new Error("BTCC committed promotion requires authoritative reconciliation");
  }
  if (intent.status === "reserved") {
    if (!sameRef(targetSnapshot.ref, workspace.baselineSnapshotRef)) {
      throw new Error("BTCC reserved promotion target requires authoritative reconciliation");
    }
    intent = stageCandidate(scopeId, intent, candidate, input.store);
  }
  if (sameRef(targetSnapshot.ref, candidate.ref)) {
    requireDisplacedBaseline(intent, workspace.baselineSnapshotRef);
    intent = { ...intent, status: "committed" };
    input.store.savePromotion(scopeId, intent);
  } else if (sameRef(targetSnapshot.ref, workspace.baselineSnapshotRef)) {
    requireStagedCandidate(intent, candidate.ref);
    assertActive(input.signal);
    if (intent.status === "prepared") {
      intent = { ...intent, status: "commit_intent_durable" };
      input.store.savePromotion(scopeId, intent);
    }
    exchangeCompleteTarget(intent.stagedPath, workspace.targetPath);
    const observed = captureTargetSnapshot(workspace.targetPath);
    if (!sameRef(observed.ref, candidate.ref)) {
      throw new Error("BTCC promoted target does not equal the reviewed candidate");
    }
    requireDisplacedBaseline(intent, workspace.baselineSnapshotRef);
    intent = { ...intent, status: "committed" };
    input.store.savePromotion(scopeId, intent);
  } else {
    throw new Error("BTCC promotion target drifted from its accepted baseline");
  }
  return promotionResult(intent, candidate.ref);
}

function preparePromotion(
  request: PromotionRequest,
  workspace: NonNullable<ReturnType<ArtifactStore["loadWorkspaceByRef"]>>,
): PromotionIntent {
  const transactionRef = contentRef("repository-promotion-transaction", {
    requestId: request.requestId,
    authorizationRef: request.authorizationRef,
    candidateRef: request.candidateRef,
    resolutionRef: request.resolutionRef,
    baselineRef: request.baselineRef,
    finalSnapshotRef: request.finalSnapshotRef,
    targetPath: workspace.targetPath,
    commitPrimitive: "atomic_root_exchange",
  });
  const stagedPath = join(
    dirname(workspace.targetPath),
    `.${basename(workspace.targetPath)}.${transactionRef.id}.btcc-stage`,
  );
  return {
    request,
    transactionId: transactionRef.id,
    workspaceRef: workspace.provision.workspace.ref,
    targetPath: workspace.targetPath,
    stagedPath,
    baselineSnapshotRef: workspace.baselineSnapshotRef,
    finalSnapshotRef: request.finalSnapshotRef,
    status: "reserved",
  };
}

function stageCandidate(
  scopeId: string,
  intent: PromotionIntent,
  candidate: NonNullable<ReturnType<ArtifactStore["loadSnapshot"]>>,
  store: ArtifactStore,
): PromotionIntent {
  if (existsSync(intent.stagedPath)) {
    try {
      requireStagedCandidate(intent, candidate.ref);
    } catch {
      removeOwnedRoot(intent.stagedPath);
      materializeCompleteTarget(candidate, intent.stagedPath);
    }
  } else {
    materializeCompleteTarget(candidate, intent.stagedPath);
  }
  syncCompleteTarget(intent.stagedPath);
  const prepared = { ...intent, status: "prepared" as const };
  store.savePromotion(scopeId, prepared);
  return prepared;
}

function requireStagedCandidate(intent: PromotionIntent, candidateRef: ContentRef): void {
  if (!existsSync(intent.stagedPath)) {
    throw new Error("BTCC promotion stage is missing after durable preparation");
  }
  const staged = captureTargetSnapshot(intent.stagedPath);
  if (!sameRef(staged.ref, candidateRef)) {
    throw new Error("BTCC promotion stage does not equal the reviewed candidate");
  }
}

function requireDisplacedBaseline(intent: PromotionIntent, baselineRef: ContentRef): void {
  if (!existsSync(intent.stagedPath)) {
    throw new Error("BTCC promotion lost its displaced baseline");
  }
  const displaced = captureTargetSnapshot(intent.stagedPath);
  if (!sameRef(displaced.ref, baselineRef)) {
    throw new Error("BTCC promotion cannot reconcile its displaced baseline");
  }
}

function promotionResult(
  intent: PromotionIntent,
  exactSnapshotRef: ContentRef,
): ObservationResult {
  const request = intent.request;
  const transaction = record("repository-promotion-transaction", {
    requestId: request.requestId,
    authorizationRef: request.authorizationRef,
    candidateRef: request.candidateRef,
    resolutionRef: request.resolutionRef,
    baselineRef: request.baselineRef,
    finalSnapshotRef: request.finalSnapshotRef,
    targetPath: intent.targetPath,
    commitPrimitive: "atomic_root_exchange",
  });
  if (transaction.ref.id !== intent.transactionId) {
    throw new Error("BTCC promotion transaction identity changed during replay");
  }
  const prepared = journal(transaction.ref, undefined, "prepared");
  const verified = journal(transaction.ref, prepared.ref, "baseline_verified");
  const durable = journal(transaction.ref, verified.ref, "commit_intent_durable");
  const commitReceipt = record("promotion-commit-receipt", {
    transactionRef: transaction.ref,
    targetStateAfterSha256: exactSnapshotRef.sha256,
    primitive: "atomic_root_exchange",
  });
  const observed = journal(transaction.ref, durable.ref, "commit_observed", {
    commitReceiptRef: commitReceipt.ref,
  });
  const promotedSnapshot = record("promoted-target-snapshot", {
    transactionRef: transaction.ref,
    commitReceiptRef: commitReceipt.ref,
    materializableSnapshotRef: exactSnapshotRef,
    completeTargetSha256: exactSnapshotRef.sha256,
  });
  const cleanupReceipt = record("promotion-cleanup-receipt", {
    transactionRef: transaction.ref,
    commitObservedJournalRef: observed.ref,
    removedOwnedRootRefs: [],
    preservedBaselineSnapshotRef: intent.baselineSnapshotRef,
  });
  const closed = journal(transaction.ref, observed.ref, "closed", {
    cleanupReceiptRef: cleanupReceipt.ref,
    promotedSnapshotRef: promotedSnapshot.ref,
  });
  return {
    requestId: request.requestId,
    outcome: "promoted",
    observationRef: contentRef("promotion-operation", {
      requestId: request.requestId,
      transactionRef: transaction.ref,
      promotedSnapshotRef: promotedSnapshot.ref,
    }),
    transactionRef: transaction.ref,
    commitJournalRef: closed.ref,
    promotionReceiptRef: commitReceipt.ref,
    promotedSnapshotRef: promotedSnapshot.ref,
    promotionRecords: {
      transaction,
      journals: [prepared, verified, durable, observed, closed],
      commitReceipt,
      promotedSnapshot,
      cleanupReceipt,
    },
    content: `promoted:${exactSnapshotRef.sha256}`,
  };
}

function resolvePromotionTarget(
  envelope: PhaseEnvelope,
  request: PromotionRequest,
): { workspaceRef: ContentRef } {
  const state = requireRecord(envelope.context.stateInput, "Promotion Execution state");
  const executionTarget = requireRecord(state.executionTarget, "Promotion execution target");
  const target = requireRecord(executionTarget.target, "Promotion target");
  const expected = {
    authorizationRef: requireRef(target.authorizationRef, "authorizationRef"),
    candidateRef: requireRef(target.candidateRef, "candidateRef"),
    resolutionRef: requireRef(target.resolutionRef, "resolutionRef"),
    baselineRef: requireRef(target.baselineRef, "baselineRef"),
    finalSnapshotRef: requireRef(target.finalSnapshotRef, "finalSnapshotRef"),
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (!sameRef(expected[key], request[key])) {
      throw new Error(`BTCC promotion request changed ${key}`);
    }
  }
  return { workspaceRef: requireRef(target.workspaceRef, "workspaceRef") };
}

function requireRef(value: unknown, label: string): ContentRef {
  const recordValue = requireRecord(value, label);
  if (typeof recordValue.id !== "string" || typeof recordValue.sha256 !== "string") {
    throw new Error(`BTCC promotion ${label} is invalid`);
  }
  return { id: recordValue.id, sha256: recordValue.sha256 };
}

function record<Body extends Record<string, unknown>>(kind: string, body: Body) {
  return { ref: contentRef(kind, body), ...body };
}

function journal(
  transactionRef: ContentRef,
  previousRef: ContentRef | undefined,
  state: string,
  extra: Record<string, unknown> = {},
) {
  const body = {
    transactionRef,
    ...(previousRef ? { previousRef } : {}),
    sequence: ["prepared", "baseline_verified", "commit_intent_durable", "commit_observed", "closed"]
      .indexOf(state) + 1,
    state,
    ...extra,
  };
  return { ref: contentRef("repository-promotion-journal", body), ...body };
}
