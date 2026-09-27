import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { ListChecks, Tag } from "@/butler-ds";
import { useComposerStore } from "./composerStore";

export function ComposerPlanModeBadge() {
  useAppLocale();
  const planMode = useComposerStore((store) => store.planMode);
  const setPlanMode = useComposerStore((store) => store.handlePlanModeChange);

  if (!planMode) return null;
  return (
    <Tag
      data-test-class="composer-plan-mode-badge"
      icon={<ListChecks aria-hidden="true" size="xs" />}
      onRemove={() => setPlanMode(false)}
      removeLabel={`${appCopy.composer.plan} ${appCopy.common.cancel}`}
    >
      {appCopy.composer.plan}
    </Tag>
  );
}
