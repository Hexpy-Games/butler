import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, ListChecks, Typo, X } from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import styles from "./ComposerPlanModeBadge.module.css";

export function ComposerPlanModeBadge() {
  useAppLocale();
  const planMode = useComposerStore((store) => store.planMode);
  const setPlanMode = useComposerStore((store) => store.handlePlanModeChange);

  if (!planMode) return null;
  return (
    <span className={styles.badge} data-test-class="composer-plan-mode-badge">
      <ListChecks aria-hidden="true" size={11} />
      <Typo.Caption className={styles.label}>
        {appCopy.composer.plan}
      </Typo.Caption>
      <Button
        aria-label={`${appCopy.composer.plan} ${appCopy.common.cancel}`}
        type="button"
        variant="inline"
        onClick={() => setPlanMode(false)}
      >
        <X size={11} />
      </Button>
    </span>
  );
}
