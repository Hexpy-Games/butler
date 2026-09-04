import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, ListChecks } from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import styles from "./ComposerPlanDecisionSurface.module.css";

export function ComposerPlanDecisionSurface({
  decision,
}: {
  decision: ComposerPlanDecision;
}) {
  return (
    <div className={styles.surface} data-test-class="composer-plan-decision">
      <div className={styles.plan}>
        <ListChecks aria-hidden="true" size={18} />
        <span className={styles.title}>{decision.planTitle}</span>
      </div>
      <div className={styles.actions}>
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
            onClick={decision.onOpenInstruction}
            size="sm"
            type="button"
            variant="outline"
          >
            {appCopy.composer.planInstruction}
          </Button>
        </ButtonContainer>
      </div>
    </div>
  );
}
