import { appCopy } from "@/app/copy.ts";
import { Button, ListChecks, Typo, X } from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import styles from "./ComposerPlanModeBadge.module.css";

export function ComposerPlanModeBadge() {
  const planMode = useComposerStore((store) => store.planMode);
  const setPlanMode = useComposerStore((store) => store.handlePlanModeChange);

  if (!planMode) return null;
  return (
    <span className={styles.badge} data-test-class="composer-plan-mode-badge">
      <ListChecks aria-hidden="true" size={13} />
      <Typo.Caption className={styles.label}>
        {appCopy.composer.plan}
      </Typo.Caption>
      <Button
        aria-label={`${appCopy.composer.plan} ${appCopy.common.cancel}`}
        size="icon-xs"
        type="button"
        variant="borderless"
        onClick={() => setPlanMode(false)}
      >
        <X size={12} />
      </Button>
    </span>
  );
}
