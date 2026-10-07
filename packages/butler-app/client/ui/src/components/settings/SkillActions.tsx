import { useEffect, useId, useRef } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, FieldError, Stack } from "@/butler-ds";

export function SkillActions({
  onImport,
  onCreate,
  error,
}: {
  error?: string;
  onImport: () => void;
  onCreate: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings.actions;
  const errorId = useId();
  const importRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (error) importRef.current?.focus(); }, [error]);
  return (
    <Stack gap="xs">
    <ButtonContainer size="sm">
      <Button ref={importRef} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} type="button" variant="outline" size="sm" onClick={onImport}>
        {copy.importSkill}
      </Button>
      <Button type="button" size="sm" onClick={onCreate}>
        {copy.createSkillWithChat}
      </Button>
    </ButtonContainer>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Stack>
  );
}
