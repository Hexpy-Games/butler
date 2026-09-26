import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { ComposerDecisionAttachment } from "./ComposerDecisionAttachment";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";

export function ComposerPlanInstructionContext({
  decision,
}: {
  decision: ComposerPlanDecision;
}) {
  useAppLocale();
  return (
    <ComposerDecisionAttachment
      testClass="composer-plan-instruction-context"
      title={decision.planTitle}
      label={appCopy.composer.planInstructionActive}
      onShowDecision={decision.onShowDecision}
    />
  );
}
