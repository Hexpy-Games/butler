import type {
  RecordWorkCheckpointCommand,
  RecordWorkDispositionCommand,
  RecordWorkReviewCommand,
  ReplaceWorkPlanCommand,
} from "../../../btcc/work/index.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import { canonicalJson, projectWorkRecordId } from "./project-work-json.ts";
import { operationChildren } from "./project-work-replay-context.ts";
import type { CurrentProjectWorkSnapshot } from "./project-work-snapshot.ts";
import type { ProjectWorkOperationIdentity } from "./project-work-contracts.ts";
import { mutationIdentity } from "./project-work-write-context.ts";
import {
  proveProjectWorkOperationReceipt,
  type ProjectWorkOperationOutcome,
} from "./project-work-operation-receipt-proof.ts";

export function proveProjectWorkDiagnosticOutcome(input: {
  command: { turnId: string; workId: string };
  identity: ProjectWorkOperationIdentity;
  outcome: ProjectWorkOperationOutcome;
  current: CurrentProjectWorkSnapshot;
}): void {
  const children = operationChildren(input.current.children, input.identity);
  proveProjectWorkOperationReceipt(
    input.outcome,
    input.command.workId,
    children,
    false,
  );
  const child = only(
    children,
    "butler.btcc-project-work-closeout-diagnostic.v1",
  );
  if (
    children.length !== 1 ||
    child.diagnostic.turnId !== input.command.turnId ||
    child.diagnostic.code !== "closeout_missing"
  )
    invalid();
}

export function proveProjectWorkPlanOutcome(input: {
  command: ReplaceWorkPlanCommand;
  outcome: ProjectWorkOperationOutcome;
  current: CurrentProjectWorkSnapshot;
}): void {
  const identity = mutationIdentity(input.command);
  const children = operationChildren(input.current.children, identity);
  proveProjectWorkOperationReceipt(
    input.outcome,
    input.current.view.workId,
    children,
  );
  const planChild = only(children, "butler.btcc-project-work-plan.v1");
  const plan = planChild.plan;
  if (
    plan.planRevisionId !== projectWorkRecordId("plan", identity.id) ||
    plan.objective !== input.command.objective ||
    canonicalJson(plan.governingRefs ?? []) !==
      canonicalJson(input.command.governingRefs) ||
    canonicalJson(plan.actions) !== canonicalJson(input.command.actions) ||
    canonicalJson(plan.checks) !== canonicalJson(input.command.checks) ||
    plan.originTurnId !== input.command.turnId
  )
    invalid();
  const checkpoints = operationCheckpoints(children);
  const roles = input.command.openingPlan
    ? (["conception", "plan"] as const)
    : (["plan"] as const);
  if (checkpoints.length !== roles.length) invalid();
  const firstRevision = (input.command.expectedProgressRevision ?? 0) + 1;
  roles.forEach((role, index) =>
    proveCheckpoint(checkpoints[index]!, {
      identity: `${identity.id}\0${role}`,
      revision: firstRevision + index,
      planRevisionId: plan.planRevisionId,
      stage: role === "conception" ? "conception" : "planning",
      actionProgress: input.command.actionProgress,
      publicSummary: input.command.objective,
      nextStep: input.command.actions[0]?.description ?? "",
      originTurnId: input.command.turnId,
    }),
  );
}

export function proveProjectWorkCheckpointOutcome(input: {
  command: RecordWorkCheckpointCommand;
  outcome: ProjectWorkOperationOutcome;
  current: CurrentProjectWorkSnapshot;
}): void {
  const identity = mutationIdentity(input.command);
  const children = operationChildren(input.current.children, identity);
  proveProjectWorkOperationReceipt(
    input.outcome,
    input.current.view.workId,
    children,
  );
  const child = only(children, "butler.btcc-project-work-checkpoint.v1");
  if (children.length !== 1) invalid();
  proveCheckpoint(child, {
    identity: identity.id,
    revision: input.command.expectedProgressRevision + 1,
    planRevisionId: input.command.expectedPlanRevisionId,
    stage: input.command.stage,
    actionProgress: input.command.actionProgress,
    publicSummary: input.command.publicSummary,
    nextStep: input.command.nextStep,
    originTurnId: input.command.turnId,
  });
}

export function proveProjectWorkReviewOutcome(input: {
  command: RecordWorkReviewCommand;
  outcome: ProjectWorkOperationOutcome;
  current: CurrentProjectWorkSnapshot;
}): void {
  const identity = mutationIdentity(input.command);
  const children = operationChildren(input.current.children, identity);
  proveProjectWorkOperationReceipt(
    input.outcome,
    input.current.view.workId,
    children,
  );
  const reviewChild = only(children, "butler.btcc-project-work-review.v1");
  const review = reviewChild.review;
  if (
    review.subject !== input.command.subject ||
    review.verdict !== input.command.verdict ||
    review.summary !== input.command.summary ||
    canonicalJson(review.corrections) !==
      canonicalJson(input.command.corrections) ||
    review.boundPlanRevisionId !==
      (input.command.subject === "result"
        ? undefined
        : input.command.expectedPlanRevisionId) ||
    review.boundResultReviewRevisionId !==
      input.command.expectedResultReviewRevisionId ||
    canonicalJson(review.boundActionProgress ?? null) !==
      canonicalJson(
        input.command.subject === "plan"
          ? null
          : input.command.actionProgress,
      ) ||
    review.boundResultRefs.length !== input.command.expectedResultSequence ||
    reviewChild.boundResultSequence !== input.command.expectedResultSequence ||
    review.originTurnId !== input.command.turnId
  )
    invalid();
  const checkpoints = operationCheckpoints(children);
  const expected: Array<{ role: "entry" | "exit"; stage: string }> = [];
  if (
    input.command.subject === "completion" ||
    input.command.currentStage !== input.command.entryStage ||
    input.command.progressChanged
  )
    expected.push({ role: "entry", stage: input.command.entryStage });
  if (input.command.nextStage !== input.command.entryStage)
    expected.push({ role: "exit", stage: input.command.nextStage });
  if (checkpoints.length !== expected.length) invalid();
  expected.forEach((item, index) =>
    proveCheckpoint(checkpoints[index]!, {
      identity: `${identity.id}\0${input.command.entryStage}-${item.role}`,
      revision: input.command.expectedProgressRevision + index + 1,
      planRevisionId: input.command.expectedPlanRevisionId,
      stage: item.stage,
      actionProgress: input.command.actionProgress,
      publicSummary: input.command.summary,
      nextStep: input.command.corrections[0] ?? "",
      originTurnId: input.command.turnId,
    }),
  );
}

export function proveProjectWorkDispositionOutcome(input: {
  command: RecordWorkDispositionCommand;
  outcome: ProjectWorkOperationOutcome;
  current: CurrentProjectWorkSnapshot;
}): void {
  const identity = mutationIdentity(input.command);
  const children = operationChildren(input.current.children, identity);
  proveProjectWorkOperationReceipt(
    input.outcome,
    input.current.view.workId,
    children,
  );
  const child = only(children, "butler.btcc-project-work-disposition.v1");
  const disposition = child.disposition;
  if (
    disposition.disposition !== input.command.disposition ||
    disposition.summary !== input.command.summary ||
    canonicalJson(disposition.actionUpdates) !==
      canonicalJson(input.command.actionUpdates ?? []) ||
    canonicalJson(disposition.remainingActions) !==
      canonicalJson(input.command.remainingActions ?? []) ||
    (disposition.nextCondition ?? null) !==
      (input.command.nextCondition ?? null) ||
    canonicalJson(disposition.evidenceRefs) !==
      canonicalJson(input.command.evidenceRefs ?? []) ||
    canonicalJson(disposition.followups) !==
      canonicalJson(input.command.followups ?? []) ||
    disposition.runtimeOwnedOpen !==
      (input.command.disposition === "open" &&
        input.command.runtimeOwnedOpenGeneration?.version === 1) ||
    disposition.originTurnId !== input.command.turnId ||
    disposition.materialFingerprint !==
      child.materialSnapshot.materialFingerprint ||
    (input.current.manifest.latestDispositionRevisionId ===
      disposition.dispositionRevisionId &&
      (input.current.manifest.materialFingerprint !==
        disposition.materialFingerprint ||
        canonicalJson(input.current.manifest.materialSnapshot) !==
          canonicalJson(child.materialSnapshot)))
  )
    invalid();
  const checkpoints = operationCheckpoints(children);
  if (child.materialSnapshot.currentPlan) {
    if (checkpoints.length !== 1 || !child.materialSnapshot.latestCheckpoint)
      invalid();
    const snapshot = child.materialSnapshot;
    const latestCheckpoint = snapshot.latestCheckpoint;
    const currentPlan = snapshot.currentPlan;
    if (!latestCheckpoint || !currentPlan) invalid();
    proveCheckpoint(checkpoints[0]!, {
      identity: `${identity.id}\0disposition`,
      revision: latestCheckpoint.revision,
      planRevisionId: currentPlan.planRevisionId,
      stage: latestCheckpoint.stage,
      actionProgress: snapshot.actionProgress,
      publicSummary: input.command.summary,
      nextStep:
        input.command.remainingActions?.[0] ??
        input.command.nextCondition ??
        "",
      originTurnId: input.command.turnId,
    });
  } else if (checkpoints.length !== 0) invalid();
}

function proveCheckpoint(
  child: CheckpointChild,
  expected: {
    identity: string;
    revision: number;
    planRevisionId: string;
    stage: string;
    actionProgress: unknown;
    publicSummary: string;
    nextStep: string;
    originTurnId: string;
  },
): void {
  const checkpoint = child.checkpoint;
  if (
    child.checkpointIdentity !== expected.identity ||
    checkpoint.checkpointRevisionId !==
      projectWorkRecordId("checkpoint", expected.identity) ||
    checkpoint.revision !== expected.revision ||
    checkpoint.planRevisionId !== expected.planRevisionId ||
    checkpoint.stage !== expected.stage ||
    !sameProgress(checkpoint.actionProgress, expected.actionProgress) ||
    checkpoint.publicSummary !== expected.publicSummary ||
    checkpoint.nextStep !== expected.nextStep ||
    checkpoint.originTurnId !== expected.originTurnId
  )
    invalid();
}

function sameProgress(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) =>
    Array.isArray(value)
      ? value.map((item) => {
          const progress = item as {
            actionKey: string;
            status: string;
            note?: string | null;
          };
          return {
            actionKey: progress.actionKey,
            status: progress.status,
            note: progress.note ?? null,
          };
        })
      : value;
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

function operationCheckpoints(children: ProjectWorkChild[]) {
  return children
    .filter(
      (child) => child.schema === "butler.btcc-project-work-checkpoint.v1",
    )
    .sort(
      (left, right) => left.checkpoint.revision - right.checkpoint.revision,
    );
}

function only<T extends ProjectWorkChild["schema"]>(
  children: ProjectWorkChild[],
  schema: T,
): Extract<ProjectWorkChild, { schema: T }> {
  const matches = children.filter((child) => child.schema === schema);
  if (matches.length !== 1) invalid();
  return matches[0] as Extract<ProjectWorkChild, { schema: T }>;
}

type CheckpointChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-checkpoint.v1" }
>;

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
