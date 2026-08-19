import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import {
  activeTurnProgressSnapshot,
  appThemeClasses,
  firstCancellableWorker,
  isWorkerVisibleInComposer,
  runtimeModels,
} from "@/app/utils.ts";
import type {
  ModelCatalogView,
  ComposerModelState,
  SessionSummaryView,
  StewardSessionSummaryView,
  SettingsView as SettingsData,
  TurnProgressSnapshot,
  WorkerActivitySummary,
} from "@/app/types.ts";
import type { ComposerAttachment } from "./useFileAttachments";

export function useComposerState(
  summary: SessionSummaryView | null | undefined,
  turnProgress: Record<string, TurnProgressSnapshot>,
  settings: SettingsData,
  modelCatalog: ModelCatalogView,
  model: string,
  modelState: ComposerModelState,
  text: string,
  attachments: ComposerAttachment[],
  isSending: boolean,
  uploadingCount: number,
) {
  const hasSendableDraft = text.trim().length > 0 || attachments.length > 0;

  const workers = (summary?.worker_activity ?? []).filter(
    (worker): worker is WorkerActivitySummary =>
      Boolean(worker && isWorkerVisibleInComposer(worker)),
  );
  const stewardChildren = (summary?.steward_children ?? []).filter(
    (child): child is StewardSessionSummaryView => Boolean(child?.active_turn),
  );
  const stewardProgress = stewardChildren[0]?.active_turn?.progress;
  const activeProgress = stewardProgress ??
    activeTurnProgressSnapshot(summary, turnProgress);
  const taskRows = (activeProgress?.safe_progress_rows ?? []).filter(
    (row) => row.kind === "todo" && row.bridge_phase === "btcc_work_ledger",
  );

  const activeTurn = Boolean(
    activeProgress ||
    (summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)) ||
    firstCancellableWorker(workers) ||
    stewardChildren.length > 0,
  );
  const canSend =
    modelState === "ready" &&
    hasSendableDraft &&
    uploadingCount === 0 &&
    (!isSending || activeTurn);

  const context = summary?.context_details;
  const models = runtimeModels(modelCatalog);

  const activeModel =
    models.find((item) => item.model_ref === model);

  const availableReasoning = activeModel?.reasoning_efforts?.length
    ? activeModel.reasoning_efforts
    : ["none"];

  const popoverThemeClass = appThemeClasses(settings);

  return {
    hasSendableDraft,
    canSend,
    workers,
    activeTurn,
    taskRows,
    taskTurnState: activeProgress?.state,
    stewardChildren,
    context,
    models,
    modelState,
    activeModel,
    availableReasoning,
    popoverThemeClass,
  };
}
