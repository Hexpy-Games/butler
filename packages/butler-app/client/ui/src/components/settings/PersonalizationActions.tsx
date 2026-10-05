import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, Globe2 } from "@/butler-ds";
export function PersonalizationActions({ saving, hasChanges, onSave }: {
  saving: boolean; hasChanges: boolean; onSave: () => Promise<void>;
}) {
  useAppLocale();
  const copy = appCopy.settings;
  return <ButtonContainer size="default" justify="end">
    <Button type="button" onClick={onSave} disabled={saving || !hasChanges}>
      <Globe2 size="md" /> {copy.actions.applyPersonalization}
    </Button>
  </ButtonContainer>;
}
