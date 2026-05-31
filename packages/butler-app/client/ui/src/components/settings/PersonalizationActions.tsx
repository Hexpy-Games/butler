import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, Globe2 } from "@/butler-ds";
import type { PersonalizationDraft } from "./settingsTypes";

export function PersonalizationActions({
  saving,
  personalizationLoaded,
  clearProfileQueued,
  hasChanges,
  setPersonalizationDraft,
  onSave,
}: {
  saving: boolean;
  personalizationLoaded: boolean;
  clearProfileQueued: boolean;
  hasChanges: boolean;
  setPersonalizationDraft: (
    draft:
      | PersonalizationDraft
      | ((current: PersonalizationDraft) => PersonalizationDraft),
  ) => void;
  onSave: () => Promise<void>;
}) {
  const copy = appCopy.settings;
  return (
    <ButtonContainer size="default" justify="end">
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          setPersonalizationDraft((current) => ({
            ...current,
            profiling: { ...current.profiling, clearProfile: true },
          }))
        }
        disabled={saving || !personalizationLoaded || clearProfileQueued}
      >
        {clearProfileQueued
          ? copy.actions.clearProfileQueued
          : copy.actions.clearProfile}
      </Button>
      <Button type="button" onClick={onSave} disabled={saving || !hasChanges}>
        <Globe2 size={15} /> {copy.actions.applyPersonalization}
      </Button>
    </ButtonContainer>
  );
}
