import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, ListChecks } from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import { ComposerDecisionSurface } from "./ComposerDecisionSurface";

export function ComposerPlanDecisionSurface({ decision }: { decision: ComposerPlanDecision }) {
  return <ComposerDecisionSurface
    icon={<ListChecks aria-hidden="true" size={18} />}
    title={decision.planTitle}
    onOpen={decision.onOpenPlan}
    testClass="composer-plan-decision"
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
