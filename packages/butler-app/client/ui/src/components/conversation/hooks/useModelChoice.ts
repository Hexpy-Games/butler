import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { AppModelSummary, ReasoningEffort } from "@/app/types.ts";
import type { ComposerControlPatch } from "./useComposerControls";

export function useModelChoice(
  reasoning: ReasoningEffort,
  setModel: (model: string) => void,
  setReasoning: (reasoning: ReasoningEffort) => void,
  persistControls: (partial: ComposerControlPatch) => void,
  composerSelectionTouchedRef: MutableRefObject<boolean>,
) {
  const handleModelChoice = useCallback(
    (nextModel: AppModelSummary) => {
      const nextReasoning =
        (nextModel.reasoning_efforts ?? []).includes(reasoning) &&
        !(
          nextModel.provider_id === "local" &&
          nextModel.local_reasoning_budget_ratio &&
          reasoning === "none"
        )
          ? reasoning
          : (nextModel.default_reasoning_effort ?? "medium");
      composerSelectionTouchedRef.current = true;
      setModel(nextModel.model_ref);
      setReasoning(nextReasoning);
      persistControls({
        model: nextModel.model_ref,
        reasoning_effort: nextReasoning,
      });
    },
    [reasoning, setModel, setReasoning, persistControls, composerSelectionTouchedRef],
  );

  return handleModelChoice;
}
