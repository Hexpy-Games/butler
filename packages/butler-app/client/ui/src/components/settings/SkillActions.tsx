import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer } from "@/butler-ds";

export function SkillActions({
  onImport,
  onCreate,
}: {
  onImport: () => void;
  onCreate: () => void;
}) {
  const copy = appCopy.settings.actions;
  return (
    <ButtonContainer size="sm">
      <Button type="button" variant="outline" size="sm" onClick={onImport}>
        {copy.importSkill}
      </Button>
      <Button type="button" size="sm" onClick={onCreate}>
        {copy.createSkillWithChat}
      </Button>
    </ButtonContainer>
  );
}
