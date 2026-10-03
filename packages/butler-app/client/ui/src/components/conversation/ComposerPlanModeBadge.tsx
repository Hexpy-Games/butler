import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { ListChecks, PillButton, Stack, X } from "@/butler-ds";
import { useComposerStore } from "./composerStore";

export function ComposerPlanModeBadge() {
  useAppLocale();
  const planMode = useComposerStore((store) => store.planMode);
  const setPlanMode = useComposerStore((store) => store.handlePlanModeChange);

  if (!planMode) return null;
  return (
    <PillButton surface="glass"
      data-test-class="composer-plan-mode-badge"
      icon={<ListChecks aria-hidden="true" size="xs" />}
      onClick={() => setPlanMode(false)}
      aria-label={`${appCopy.composer.plan} ${appCopy.common.cancel}`}
    >
      <Stack as="span" align="row" cross="center" gap="xs">
        {appCopy.composer.plan}<X aria-hidden="true" size="xs" />
      </Stack>
    </PillButton>
  );
}
