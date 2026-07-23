import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  LiveTurnStep,
  ModelCell,
  OperationObservation,
  TraceObservation,
  TurnObservation,
} from "../contracts.ts";
import { satisfiesLiveTraceContract } from "./live-trace-contract.ts";
import { changedFiles, type FileSnapshot } from "./workspace-observation.ts";

export { snapshotFiles } from "./workspace-observation.ts";

type CheckpointRow = {
  semantic_state: string;
  turn_revision: number;
  accepted_product_json: string | null;
  actual_identity_json: string | null;
};

export function readTurnObservation(input: {
  dbPath: string;
  turnId: string;
  step: LiveTurnStep;
  modelCell: ModelCell;
  workspaceBefore: FileSnapshot;
  workspaceAfter: FileSnapshot;
  outcome?: { kind: string; content?: string };
  error?: unknown;
}): TurnObservation {
  const db = new Database(input.dbPath, { readonly: true });
  try {
    const turn = db
      .query<
        {
          route: string | null;
          semantic_state: string;
          final_disposition: string | null;
        },
        [string]
      >(
        `
      SELECT route, semantic_state, final_disposition FROM btcc_turns WHERE turn_id = ?
    `,
      )
      .get(input.turnId);
    const checkpoints = db
      .query<CheckpointRow, [string]>(
        `
      SELECT semantic_state, turn_revision, accepted_product_json, actual_identity_json
      FROM btcc_checkpoints WHERE turn_id = ? ORDER BY turn_revision
    `,
      )
      .all(input.turnId);
    const trace = reconstructTrace(checkpoints, turn?.semantic_state ?? null);
    const actualIdentities = checkpoints
      .filter((row) => row.actual_identity_json)
      .map(
        (row) =>
          JSON.parse(
            row.actual_identity_json!,
          ) as TurnObservation["acceptedProductActualIdentities"][number],
      );
    const providerRoundActualIdentities = db
      .query<
        {
          actual_identity_json: string;
        },
        [string]
      >(
        `
      SELECT model_round.actual_identity_json
      FROM btcc_phase_model_rounds model_round
      JOIN btcc_checkpoints checkpoint ON checkpoint.checkpoint_id = model_round.checkpoint_id
      WHERE checkpoint.turn_id = ?
      ORDER BY checkpoint.turn_revision, model_round.round_ordinal
    `,
      )
      .all(input.turnId)
      .map(
        (row) =>
          JSON.parse(
            row.actual_identity_json,
          ) as TurnObservation["providerRoundActualIdentities"][number],
      );
    const operations = readOperations(db, input.turnId);
    const checks = runtimeChecks({
      step: input.step,
      modelCell: input.modelCell,
      route: turn?.route ?? null,
      finalDisposition: turn?.final_disposition ?? null,
      trace,
      actualIdentities: providerRoundActualIdentities,
    });
    return {
      stepId: input.step.stepId,
      turnId: input.turnId,
      selected: input.modelCell,
      providerRoundActualIdentities,
      acceptedProductActualIdentities: actualIdentities,
      route: turn?.route ?? null,
      trace,
      operations,
      recordKinds: readRecordKinds(db),
      changedArtifacts: changedFiles(
        input.workspaceBefore,
        input.workspaceAfter,
      ),
      finalDisposition: turn?.final_disposition ?? null,
      runtimeChecks: checks,
      proofGaps: proofGaps(input.step),
      ...(input.outcome
        ? {
            outcome: {
              kind: input.outcome.kind,
              ...(input.outcome.content
                ? { contentSha256: sha256(input.outcome.content) }
                : {}),
            },
          }
        : {}),
      ...(input.error ? { error: safeError(input.error) } : {}),
    };
  } finally {
    db.close();
  }
}

function reconstructTrace(
  rows: CheckpointRow[],
  terminalState: string | null,
): TraceObservation[] {
  return rows.map((row, index) => {
    const nextState = rows[index + 1]?.semantic_state ?? terminalState;
    return {
      ordinal: index + 1,
      turnRevision: row.turn_revision,
      state: row.semantic_state,
      acceptedEvent: acceptedEvent(row, nextState, rows.slice(0, index)),
      source: "persisted_transition_reconstruction",
    };
  });
}

function acceptedEvent(
  row: CheckpointRow,
  nextState: string | null,
  previousRows: CheckpointRow[],
): string | null {
  if (row.semantic_state === "admitted") return "TurnActivated";
  if (
    row.semantic_state === "delivery_committed" &&
    nextState === "delivered"
  ) {
    return "DeliveryObserved";
  }
  if (row.semantic_state === "work_frontier") {
    if (nextState === "task_execution") return "WorkTaskSelected";
    if (nextState === "consolidation") {
      return previousRows.some(isPromotionAuthorization)
        ? "PromotionFrontierClosed" : "WorkFrontierClosed";
    }
  }
  if (!row.accepted_product_json) return null;
  const product = JSON.parse(row.accepted_product_json) as Record<
    string,
    unknown
  >;
  return eventForProduct(product);
}

function isPromotionAuthorization(row: CheckpointRow): boolean {
  if (!row.accepted_product_json) return false;
  const product = JSON.parse(row.accepted_product_json) as Record<string, unknown>;
  return product.kind === "promotion_authorization";
}

function eventForProduct(product: Record<string, unknown>): string | null {
  const fixed: Record<string, string> = {
    opening_answer: "OpeningAnswerAccepted",
    opening_continuation: "OpeningContinuationAccepted",
    goal_contract_candidate: "GoalContractCandidateSubmitted",
    goal_contract_accepted: "GoalContractReviewAccepted",
    plan_candidate: "PlanCandidateSubmitted",
    planning_accepted: "PlanningReviewAccepted",
    planning_revision_required: "PlanningRevisionRequested",
    result_candidate: "ResultCandidateSubmitted",
    feedback_intent: "FeedbackIntentAccepted",
    feedback_plan_candidate: "FeedbackPlanCandidateSubmitted",
    feedback_planning_accepted: "FeedbackPlanningReviewAccepted",
    feedback_planning_revision_required: "FeedbackPlanningRevisionRequested",
    managed_deferral: "ManagedDeferralAccepted",
    promotion_deferral: "PromotionDeferralAccepted",
    consolidation_repair: "ConsolidationRepairRequired",
    final_dossier: "FinalDossierAccepted",
    promotion_authorization: "PromotionAuthorized",
    prepared_report: "PreparedReportAccepted",
  };
  if (typeof product.kind !== "string") return null;
  if (product.kind === "task_review") {
    const review = record(product.review);
    return review?.verdict === "passed"
      ? "TaskReviewPassed"
      : "TaskReviewFailed";
  }
  return fixed[product.kind] ?? null;
}

function readOperations(db: Database, turnId: string): OperationObservation[] {
  return db
    .query<{ request_json: string; projection_json: string }, [string]>(
      `
    SELECT operation.request_json, operation.projection_json
    FROM btcc_phase_operation_result_links operation
    JOIN btcc_checkpoints checkpoint ON checkpoint.checkpoint_id = operation.checkpoint_id
    WHERE checkpoint.turn_id = ? ORDER BY operation.rowid
  `,
    )
    .all(turnId)
    .map((row) => {
      const request = JSON.parse(row.request_json) as Record<string, unknown>;
      const result = JSON.parse(row.projection_json) as Record<string, unknown>;
      return {
        requestId: String(request.requestId ?? ""),
        kind: String(request.kind ?? ""),
        capabilityRef: String(request.capabilityRef ?? ""),
        outcome: String(result.outcome ?? ""),
        ...(isContentRef(result.observationRef)
          ? { observationRef: result.observationRef }
          : {}),
      };
    });
}

function readRecordKinds(db: Database): Array<{ kind: string; count: number }> {
  return db
    .query<{ kind: string; count: number }, []>(
      `
    SELECT kind, COUNT(*) AS count FROM btcc_records GROUP BY kind ORDER BY kind
  `,
    )
    .all();
}

function runtimeChecks(input: {
  step: LiveTurnStep;
  modelCell: ModelCell;
  route: string | null;
  finalDisposition: string | null;
  trace: TraceObservation[];
  actualIdentities: TurnObservation["providerRoundActualIdentities"];
}) {
  const requiredTrace = satisfiesLiveTraceContract(input.trace, input.step);
  const forbidden = input.trace.filter((actual) =>
    input.step.forbiddenStates.includes(actual.state),
  );
  const exactActual =
    input.actualIdentities.length > 0 &&
    input.actualIdentities.every(
      (identity) =>
        identity.provider === input.modelCell.provider &&
        identity.model === input.modelCell.model &&
        identity.reasoningEffort === input.modelCell.reasoningEffort,
    );
  return [
    {
      check: "expected_route",
      passed: input.route === input.step.expectedRoute,
      detail: input.route ?? "missing",
    },
    {
      check: "expected_final_disposition",
      passed: input.finalDisposition === input.step.expectedFinalDisposition,
      detail: input.finalDisposition ?? "missing",
    },
    { check: "required_trace", passed: requiredTrace },
    {
      check: "forbidden_states_absent",
      passed: forbidden.length === 0,
      detail: forbidden.map((row) => row.state).join(","),
    },
    {
      check: "provider_round_actual_identity",
      passed: exactActual,
      detail: `${input.actualIdentities.length} provider rounds`,
    },
  ];
}

function proofGaps(step: LiveTurnStep): string[] {
  return [
    "generated_diagnostic_fixtures_are_not_canonical_fixture_snapshots",
    "app_ui_ingress_and_projection_not_observed",
    "goal_field_semantic_assertions_have_no_canonical_evaluator",
    ...(step.expectedEffects.length
      ? ["typed_effect_receipt_assertions_have_no_test_projection"]
      : []),
    ...(step.expectedArtifacts.length
      ? ["manifest_artifact_assertions_have_no_canonical_resolver"]
      : []),
    ...(step.checkpointAssertions.length
      ? ["checkpoint_assertion_refs_have_no_canonical_resolver"]
      : []),
    ...(step.appActions.length
      ? ["ui_stop_action_cannot_be_driven_through_composition_runtime"]
      : []),
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isContentRef(value: unknown): value is { id: string; sha256: string } {
  const item = record(value);
  return typeof item?.id === "string" && typeof item.sha256 === "string";
}

function safeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
