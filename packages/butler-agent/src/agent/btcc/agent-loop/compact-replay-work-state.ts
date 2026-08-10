import type {
  DurableWorkActionStatus,
  DurableWorkReview,
  DurableWorkToolName,
  DurableWorkView,
  WorkStage,
} from "../work/index.ts";

const MAX_COMPACT_WORK_RESULT_REFS = 16;
const MAX_COMPACT_WORK_REF_LENGTH = 256;
const MAX_COMPACT_WORK_ACTION_ROWS = 24;

export type BtccCompactReplayExactReadIdentity = {
  kind: "direct";
  result_ref: string;
  revision: null;
  result_sha256: string | null;
};

type BtccCompactReplayRecovery =
  | { kind: "initial_authoritative_work" }
  | {
    kind: "exact_operation_request";
    identity: BtccCompactReplayExactReadIdentity;
    pointer: "/result/work/actions" | "/request/corrections";
  };

export type BtccCompactReplayWorkState = {
  work_id: string;
  status: DurableWorkView["status"];
  stage: WorkStage | null;
  allowed_next_stages: WorkStage[];
  revisions: {
    plan: number | null;
    checkpoint: number | null;
    plan_review: number | null;
    result_review: number | null;
    completion_validation: number | null;
  };
  action_states: Record<DurableWorkActionStatus, number>;
  actions: {
    total: number;
    represented: number;
    omitted: number;
    unresolved_total: number;
    unresolved_represented: number;
    unresolved_omitted: number;
    rows: Array<{
      plan_ordinal: number;
      status: DurableWorkActionStatus;
    }>;
    action_key_recovery: BtccCompactReplayRecovery;
  };
  review_correction: {
    count: number;
    review_revision: number;
    recovery: BtccCompactReplayRecovery;
  } | null;
  result_refs: {
    total: number;
    represented: number;
    omitted: number;
    latest: Array<{
      result_ref: string;
      revision: number | null;
      status: "completed" | "failed" | "cancelled";
    }>;
  };
};

export type BtccCompactReplayWorkControlReceipt = {
  operation: DurableWorkToolName;
  accepted: boolean;
  result_identity: BtccCompactReplayExactReadIdentity | null;
};

export type BtccCompactReplayWorkRecoverySources = {
  actionStates?: BtccCompactReplayExactReadIdentity;
  reviewCorrection?: BtccCompactReplayExactReadIdentity;
};

/** Projects authoritative Work without model-authored semantic text. */
export function projectCompactReplayWorkState(
  work: DurableWorkView,
  sources: BtccCompactReplayWorkRecoverySources = {},
): BtccCompactReplayWorkState {
  const actionRows = fullPlanActionRows(work);
  const representedRows = boundedActionRows(actionRows);
  const unresolvedTotal = actionRows.filter((row) =>
    !isTerminalAction(row.status)).length;
  const unresolvedRepresented = representedRows.filter((row) =>
    !isTerminalAction(row.status)).length;
  const latestReview = latestWorkReview(work);
  const resultRefs = work.resultRefs.filter((item) =>
    item.resultRef.length > 0 &&
    item.resultRef.length <= MAX_COMPACT_WORK_REF_LENGTH);
  const latestResultRefs = resultRefs.slice(-MAX_COMPACT_WORK_RESULT_REFS)
    .map((item) => ({
      result_ref: item.resultRef,
      revision: item.sequence ?? null,
      status: item.status,
    }));
  return {
    work_id: work.workId,
    status: work.status,
    stage: work.currentStage ?? null,
    allowed_next_stages: [...work.allowedNextStages],
    revisions: {
      plan: work.currentPlan?.revision ?? null,
      checkpoint: work.latestCheckpoint?.revision ?? null,
      plan_review: work.latestPlanReview?.revision ?? null,
      result_review: work.latestResultReview?.revision ?? null,
      completion_validation: work.latestCompletionValidation?.revision ?? null,
    },
    action_states: countActionStates(actionRows),
    actions: {
      total: actionRows.length,
      represented: representedRows.length,
      omitted: actionRows.length - representedRows.length,
      unresolved_total: unresolvedTotal,
      unresolved_represented: unresolvedRepresented,
      unresolved_omitted: unresolvedTotal - unresolvedRepresented,
      rows: representedRows,
      action_key_recovery: sources.actionStates
        ? exactRecovery(sources.actionStates, "/result/work/actions")
        : { kind: "initial_authoritative_work" },
    },
    review_correction: latestReview && latestReview.corrections.length > 0
      ? {
          count: latestReview.corrections.length,
          review_revision: latestReview.revision,
          recovery: sources.reviewCorrection
            ? exactRecovery(sources.reviewCorrection, "/request/corrections")
            : { kind: "initial_authoritative_work" },
        }
      : null,
    result_refs: {
      total: work.resultRefs.length,
      represented: latestResultRefs.length,
      omitted: work.resultRefs.length - latestResultRefs.length,
      latest: latestResultRefs,
    },
  };
}

/** Retains exact recovery for the latest authoritative Plan/review revisions. */
export function mergeCompactReplayWorkStates(
  states: readonly (BtccCompactReplayWorkState | null | undefined)[],
): BtccCompactReplayWorkState | null {
  const present = states.filter(
    (state): state is BtccCompactReplayWorkState => Boolean(state),
  );
  const latest = present.at(-1);
  if (!latest) return null;
  const planRecovery = present.findLast((state) =>
    state.revisions.plan === latest.revisions.plan &&
    state.actions.action_key_recovery.kind === "exact_operation_request")
    ?.actions.action_key_recovery;
  const latestCorrectionRevision = latest.review_correction?.review_revision;
  const correctionRecovery = latestCorrectionRevision !== undefined
    ? present.findLast((state) =>
        state.review_correction?.review_revision === latestCorrectionRevision &&
        state.review_correction?.recovery.kind === "exact_operation_request")
      ?.review_correction?.recovery
    : undefined;
  return {
    ...latest,
    actions: {
      ...latest.actions,
      action_key_recovery: planRecovery ??
        latest.actions.action_key_recovery,
    },
    review_correction: latest.review_correction
      ? {
          ...latest.review_correction,
          recovery: correctionRecovery ?? latest.review_correction.recovery,
        }
      : null,
  };
}

export function compactReplayExactReadIdentity(input: {
  resultRef?: string;
  resultSha256?: string;
}): BtccCompactReplayExactReadIdentity | null {
  if (!input.resultRef || input.resultRef.length > MAX_COMPACT_WORK_REF_LENGTH) {
    return null;
  }
  return {
    kind: "direct",
    result_ref: input.resultRef,
    revision: null,
    result_sha256: input.resultSha256 ?? null,
  };
}

function fullPlanActionRows(
  work: DurableWorkView,
): BtccCompactReplayWorkState["actions"]["rows"] {
  const progressByKey = new Map(work.actionProgress.map((item) => [
    item.actionKey,
    item.status,
  ]));
  return (work.currentPlan?.actions ?? []).map((action, index) => ({
    plan_ordinal: index + 1,
    status: progressByKey.get(action.actionKey) ?? "pending",
  }));
}

function boundedActionRows(
  rows: BtccCompactReplayWorkState["actions"]["rows"],
): BtccCompactReplayWorkState["actions"]["rows"] {
  return [...rows]
    .sort((left, right) =>
      Number(isTerminalAction(left.status)) -
        Number(isTerminalAction(right.status)) ||
      left.plan_ordinal - right.plan_ordinal)
    .slice(0, MAX_COMPACT_WORK_ACTION_ROWS);
}

function countActionStates(
  rows: BtccCompactReplayWorkState["actions"]["rows"],
): Record<DurableWorkActionStatus, number> {
  const counts: Record<DurableWorkActionStatus, number> = {
    pending: 0,
    active: 0,
    done: 0,
    blocked: 0,
    skipped: 0,
  };
  for (const action of rows) counts[action.status] += 1;
  return counts;
}

function latestWorkReview(work: DurableWorkView): DurableWorkReview | null {
  return [
    work.latestPlanReview,
    work.latestResultReview,
    work.latestCompletionValidation,
  ].filter((review): review is DurableWorkReview => Boolean(review))
    .sort((left, right) => left.revision - right.revision)
    .at(-1) ?? null;
}

function exactRecovery(
  identity: BtccCompactReplayExactReadIdentity,
  pointer: "/result/work/actions" | "/request/corrections",
): BtccCompactReplayRecovery {
  return { kind: "exact_operation_request", identity, pointer };
}

function isTerminalAction(status: DurableWorkActionStatus): boolean {
  return status === "done" || status === "skipped";
}
