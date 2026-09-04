import { appCopy } from "@/app/copy.ts";
import {
  Button,
  ButtonContainer,
  ListChecks,
  Notice,
} from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";

export function ComposerPlanDecisionNotice({
  decision,
}: {
  decision: ComposerPlanDecision;
}) {
  return (
    <Notice
      action={
        <ButtonContainer size="sm">
          <Button
            disabled={decision.pending}
            onClick={decision.onAccept}
            size="sm"
            type="button"
          >
            {appCopy.composer.planAccept}
          </Button>
          <Button
            disabled={decision.pending}
            onClick={decision.onReject}
            size="sm"
            type="button"
            variant="secondary"
          >
            {appCopy.composer.planReject}
          </Button>
          <Button
            disabled={decision.pending}
            onClick={decision.onFocusInstruction}
            size="sm"
            type="button"
            variant="outline"
          >
            {appCopy.composer.planInstruction}
          </Button>
        </ButtonContainer>
      }
      icon={<ListChecks size={18} />}
      message={decision.planTitle}
      title={appCopy.composer.planDecision}
      tone="info"
    />
  );
}
