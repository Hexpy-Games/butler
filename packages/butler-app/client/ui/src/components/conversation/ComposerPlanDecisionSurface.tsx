import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, ComposerDecisionPanel, ListChecks } from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";

export function ComposerPlanDecisionSurface({ decision }: { decision: ComposerPlanDecision }) {
  useAppLocale();
  return <ComposerDecisionPanel
    icon={<ListChecks aria-hidden="true" size="lg" />}
    title={decision.planTitle}
    onOpen={decision.onOpenPlan}
    data-test-class="composer-plan-decision"
    actions={<ButtonContainer size="sm" justify="end">
      <Button disabled={decision.pending} onClick={decision.onOpenInstruction} size="sm" type="button" variant="outline">
        {appCopy.composer.planInstruction}
      </Button>
      <Button disabled={decision.pending} onClick={decision.onReject} size="sm" type="button" variant="secondary">
        {appCopy.composer.planReject}
      </Button>
      <Button disabled={decision.pending} onClick={decision.onAccept} size="sm" type="button">
        {appCopy.composer.planAccept}
      </Button>
    </ButtonContainer>}
  />;
}
