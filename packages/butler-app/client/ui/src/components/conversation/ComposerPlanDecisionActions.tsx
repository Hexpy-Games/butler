import { appCopy } from "@/app/copy.ts";
import { Button } from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import styles from "./ComposerPlanDecisionActions.module.css";

export function ComposerPlanDecisionActions({
  decision,
}: {
  decision: ComposerPlanDecision;
}) {
  return (
    <span
      aria-label={appCopy.composer.planDecision}
      className={styles.actions}
      data-test-class="composer-plan-decision-actions"
      role="group"
    >
      <Button
        disabled={decision.pending}
        size="sm"
        type="button"
        onClick={decision.onAccept}
      >
        {appCopy.composer.planAccept}
      </Button>
      <Button
        disabled={decision.pending}
        size="sm"
        type="button"
        variant="borderless"
        onClick={decision.onReject}
      >
        {appCopy.composer.planReject}
      </Button>
    </span>
  );
}
