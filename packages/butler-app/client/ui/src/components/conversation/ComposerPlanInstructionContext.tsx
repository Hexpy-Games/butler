import { appCopy } from "@/app/copy.ts";
import { FileText, Typo } from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import styles from "./ComposerPlanInstructionContext.module.css";

export function ComposerPlanInstructionContext({
  decision,
}: {
  decision: ComposerPlanDecision;
}) {
  return (
    <div className={styles.wrap} data-test-class="composer-plan-instruction-context">
      <button
        aria-label={decision.planTitle}
        className={styles.document}
        onClick={decision.onShowDecision}
        type="button"
      >
        <FileText aria-hidden="true" size={13} />
        <span className={styles.title}>{decision.planTitle}</span>
        <Typo.Caption className={styles.status}>
          {appCopy.composer.planInstructionActive}
        </Typo.Caption>
      </button>
    </div>
  );
}
