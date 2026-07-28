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
  const activeProgress = activeTurnProgressSnapshot(summary, turnProgress);
  const taskProgress = activeProgress?.safe_progress_rows?.some(
      (row) => row.kind === "todo",
    )
    ? activeProgress
    : undefined;

  const activeTurn = Boolean(
    activeProgress ||
    (summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)) ||
      firstCancellableWorker(workers),
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
    taskProgress,
    context,
    models,
    modelState,
    activeModel,
    availableReasoning,
    popoverThemeClass,
  };
}
