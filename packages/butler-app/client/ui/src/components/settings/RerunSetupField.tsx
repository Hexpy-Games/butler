import { Button, SettingsField } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useOnboardingStore } from "@/stores/onboardingStore.ts";

/** Settings › General › App behavior: run the welcome and "Pick an AI" again. Models and chats stay. */
export function RerunSetupField() {
  useAppLocale();
  const openRerun = useOnboardingStore((state) => state.openRerun);
  const copy = appCopy.firstRun;
  return (
    <SettingsField
      id="rerun-setup"
      settingId="rerun-setup"
      data-test-class="settings-field"
      label={copy.rerunTitle}
      description={copy.rerunDescription}
      descriptionId="rerun-setup-description"
      control={(
        <Button
          aria-describedby="rerun-setup-description"
          id="rerun-setup"
          type="button"
          variant="outline"
          onClick={openRerun}
        >
          {copy.rerunAction}
        </Button>
      )}
    />
  );
}
