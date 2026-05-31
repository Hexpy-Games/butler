import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { AccessMode, ReasoningEffort } from "@/app/types.ts";
import type { ComposerControlPatch } from "./useComposerControls";

interface UseComposerControlHandlersProps {
  composerSelectionTouchedRef: MutableRefObject<boolean>;
  persistControls: (partial: ComposerControlPatch) => void;
  setAccessMode: (mode: AccessMode) => void;
  setPlanMode: (mode: boolean) => void;
  setReasoning: (reasoning: ReasoningEffort) => void;
}

export function useComposerControlHandlers({
  composerSelectionTouchedRef,
  persistControls,
  setAccessMode,
  setPlanMode,
  setReasoning,
}: UseComposerControlHandlersProps) {
  const markTouched = useCallback(() => {
    composerSelectionTouchedRef.current = true;
  }, [composerSelectionTouchedRef]);

  const handleAccessModeChange = useCallback(
    (mode: AccessMode) => {
      markTouched();
      setAccessMode(mode);
      persistControls({ access_mode: mode });
    },
    [setAccessMode, persistControls, markTouched],
  );

  const handlePlanModeChange = useCallback(
    (checked: boolean) => {
      markTouched();
      setPlanMode(checked);
      persistControls({ plan_mode: checked });
    },
    [setPlanMode, persistControls, markTouched],
  );

  const handleReasoningChange = useCallback(
    (effort: ReasoningEffort) => {
      markTouched();
      setReasoning(effort);
      persistControls({ reasoning_effort: effort });
    },
    [setReasoning, persistControls, markTouched],
  );

  return {
    handleAccessModeChange,
    handlePlanModeChange,
    handleReasoningChange,
  };
}
