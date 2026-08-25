export class ProjectWorkAdapterError extends Error {
  readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = "ProjectWorkAdapterError";
    this.code = message.startsWith("project_work_")
      ? message
      : "project_work_adapter_invalid";
  }
}

export class ProjectWorkPublicationNotAppliedError extends Error {
  readonly code = "project_ledger_effect_not_applied";
  constructor() {
    super("The Project Ledger publication was not applied.");
  }
}

export class ProjectWorkPublicationUncertainError extends Error {
  readonly code = "project_ledger_effect_uncertain";
  constructor() {
    super("The Project Ledger publication state could not be verified safely.");
  }
}

const KNOWN_PROJECT_WORK_ERRORS = new Set([
  "project_work_abandonment_binding_missing",
  "project_work_binding_identity_mismatch",
  "project_work_checkpoint_precondition_mismatch",
  "project_work_closeout_target_mismatch",
  "project_work_continuation_target_invalid",
  "project_work_disposition_target_mismatch",
  "project_work_expected_work_mismatch",
  "project_work_immutable_content_conflict",
  "project_work_immutable_identity_ambiguous",
  "project_work_immutable_metadata_conflict",
  "project_work_legacy_import_required",
  "project_work_managed_record_invalid",
  "project_work_material_fingerprint_invalid",
  "project_work_material_fingerprint_mismatch",
  "project_work_not_open",
  "project_work_occurrence_receipt_missing",
  "project_work_operation_time_invalid",
  "project_work_origin_turn_mismatch",
  "project_work_progress_revision_mismatch",
  "project_work_publication_empty",
  "project_work_publication_target_mismatch",
  "project_work_record_missing",
  "project_work_replay_target_missing",
  "project_work_result_attachment_required",
  "project_work_review_precondition_mismatch",
  "project_work_runtime_origin_mismatch",
  "project_work_scope_mismatch",
  "project_work_session_head_invalid",
  "project_work_snapshot_unstable",
  "project_work_turn_already_bound",
  "project_work_turn_binding_missing",
  "project_work_turn_binding_stale",
]);

export function projectWorkInvalid(message: string): never {
  throw new ProjectWorkAdapterError(message);
}

export function isProjectWorkAdapterError(
  error: unknown,
): error is ProjectWorkAdapterError {
  return error instanceof ProjectWorkAdapterError;
}

export async function typedProjectWorkPreparation<T>(
  prepare: () => Promise<T>,
): Promise<T> {
  try {
    return await prepare();
  } catch (error) {
    if (error instanceof ProjectWorkAdapterError) throw error;
    if (error instanceof Error && KNOWN_PROJECT_WORK_ERRORS.has(error.message)) {
      throw new ProjectWorkAdapterError(error.message);
    }
    throw error;
  }
}

export async function safeProjectWorkPublicOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await typedProjectWorkPreparation(operation);
  } catch (error) {
    if (
      error instanceof ProjectWorkAdapterError ||
      error instanceof ProjectLedgerEffectConflictError ||
      errorCode(error) === "project_ledger_effect_occurrence_conflict" ||
      error instanceof ProjectWorkPublicationNotAppliedError ||
      error instanceof ProjectWorkPublicationUncertainError
    )
      throw error;
    throw new ProjectWorkPublicationUncertainError();
  }
}
import { ProjectLedgerEffectConflictError } from "./external-effect-occurrence.ts";

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
