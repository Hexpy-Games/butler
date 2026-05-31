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
  SessionSummaryView,
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
  const activeProgress = activeTurnProgressSnapshot(summary, turnProgress);
  const todoRows = activeProgress?.safe_progress_rows ?? [];

  const activeTurn = Boolean(
    activeProgress ||
    (summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)) ||
      firstCancellableWorker(workers),
  );
  const canSend =
    hasSendableDraft && uploadingCount === 0 && (!isSending || activeTurn);

  const context = summary?.context_details;
  const models = runtimeModels(modelCatalog);

  const activeModel =
    models.find((item) => item.model_ref === model) ?? models[0];

  const availableReasoning = activeModel?.reasoning_efforts?.length
    ? activeModel.reasoning_efforts
    : ["none"];

  const popoverThemeClass = appThemeClasses(settings);

  return {
    hasSendableDraft,
    canSend,
    workers,
    todoRows,
    activeTurn,
    context,
    models,
    activeModel,
    availableReasoning,
    popoverThemeClass,
  };
}
