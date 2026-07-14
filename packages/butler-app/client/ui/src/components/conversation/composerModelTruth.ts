import { appCopy } from "@/app/copy.ts";
import type {
  AppModelSummary,
  ComposerModelState,
  SessionViewTurn,
} from "@/app/types.ts";
import { modelDisplayName } from "@/app/utils.ts";

export function composerModelStateLabel(state: ComposerModelState): string {
  if (state === "loading") return appCopy.composer.modelLoading;
  if (state === "error") return appCopy.composer.modelError;
  return appCopy.composer.modelUnavailable;
}

export function executionModelDetail(input: {
  turn?: SessionViewTurn | null;
  active: boolean;
  models: AppModelSummary[];
}): string | null {
  const modelRef = input.turn?.execution_model?.adapter_effective_model_ref;
  const reasoning = input.turn?.execution_controls?.reasoning_effort;
  if (!modelRef || !reasoning) return null;
  const metadata = input.models.find((model) => model.model_ref === modelRef);
  const label = metadata ? modelDisplayName(metadata) : modelRef;
  return input.active
    ? appCopy.composer.runningModel(label, reasoning)
    : appCopy.composer.lastRunModel(label, reasoning);
}
