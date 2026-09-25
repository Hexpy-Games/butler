import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { FileText, Typo } from "@/butler-ds";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import styles from "./ComposerPlanInstructionContext.module.css";

export function ComposerPlanInstructionContext({
  decision,
}: {
  decision: ComposerPlanDecision;
}) {
  useAppLocale();
  return (
    <div className={styles.wrap} data-test-class="composer-plan-instruction-context">
      <button
        aria-label={decision.planTitle}
        className={styles.document}
        onClick={decision.onShowDecision}
        type="button"
      >
        <FileText aria-hidden="true" size="sm" />
        <Typo.Label as="span" weight="regular" tone="primary" truncate>
          {decision.planTitle}
        </Typo.Label>
        <Typo.Caption tone="tertiary" wrap="nowrap">
          {appCopy.composer.planInstructionActive}
        </Typo.Caption>
      </button>
    </div>
  );
}
