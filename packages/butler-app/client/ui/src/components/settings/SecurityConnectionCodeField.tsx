import { useId } from "react";
import { appCopy, getAppLocale } from "@/app/copy.ts";
import type { SecurityView } from "@/app/types.ts";
import { Button, ButtonContainer, Input, SettingsField, Stack } from "@/butler-ds";

/** The masked connection code with its reveal, copy and rotate actions. */
export function SecurityConnectionCodeField({
  code,
  revealed,
  disabled,
  onReveal,
  onCopy,
  onRotate,
}: {
  code: SecurityView["connection_code"];
  revealed: string | null;
  disabled: boolean;
  onReveal: () => void;
  onCopy: () => void;
  onRotate: () => void;
}) {
  const copy = appCopy.settings.security;
  const inputId = useId();
  const descriptionId = useId();
  return (
    <SettingsField
      id={inputId}
      settingId="connection-code"
      label={copy.code}
      description={copy.createdAt(formatCreatedAt(code.created_at))}
      descriptionId={descriptionId}
      control={(
        <Stack gap="sm">
          <Input
            id={inputId}
            aria-describedby={descriptionId}
            readOnly
            autoComplete="off"
            spellCheck={false}
            value={revealed ?? code.masked}
          />
          <ButtonContainer size="xs">
            <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onReveal}>
              {revealed ? copy.hide : copy.reveal}
            </Button>
            <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onCopy}>
              {copy.copy}
            </Button>
            <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onRotate}>
              {copy.rotate}
            </Button>
          </ButtonContainer>
        </Stack>
      )}
    />
  );
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "medium" }).format(date);
}
