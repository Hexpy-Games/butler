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
        <button
          aria-label={decision.planTitle}
          className={styles.title}
          onClick={decision.onOpenPlan}
          type="button"
        >
          {decision.planTitle}
        </button>
      </div>
      <div className={styles.actions}>
        <ButtonContainer size="sm">
          <Button
            disabled={decision.pending}
            className={styles.decisionButton}
            onClick={decision.onAccept}
            size="sm"
            type="button"
          >
            {appCopy.composer.planAccept}
          </Button>
          <Button
            disabled={decision.pending}
            className={styles.decisionButton}
            onClick={decision.onReject}
            size="sm"
            type="button"
            variant="secondary"
          >
            {appCopy.composer.planReject}
          </Button>
          <Button
            disabled={decision.pending}
            className={styles.decisionButton}
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
