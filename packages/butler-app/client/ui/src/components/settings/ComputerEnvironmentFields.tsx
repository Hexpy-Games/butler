import { appCopy } from "@/app/copy.ts";
import { Button, FieldError, IconButton, Input, Plus, SettingsSecretRow, SettingsSecretRows, Stack, Trash2, Typo } from "@/butler-ds";
import { COMPUTER_FIELD_IDS } from "./computerAddErrors";

export type ComputerEnvironmentRow = { id: string; name: string; value: string; saved: boolean };

export function ComputerEnvironmentFields({ rows, onChange, disabled, error }: {
  rows: ComputerEnvironmentRow[];
  onChange(rows: ComputerEnvironmentRow[]): void;
  disabled: boolean;
  error?: string;
}) {
  const copy = appCopy.computers.form.environment;
  const fieldId = COMPUTER_FIELD_IDS.environment;
  const description = `${fieldId}-hint${error ? ` ${fieldId}-error` : ""}`;

  return (
    <Stack gap="xs">
      <SettingsSecretRows
        title={copy.title}
        emptyState={rows.length === 0 ? copy.empty : undefined}
        actions={
          <Button type="button" id={rows.length === 0 ? fieldId : undefined} size="xs" variant="outline"
            aria-describedby={description} disabled={disabled}
            onClick={() => onChange([...rows, { id: crypto.randomUUID(), name: "", value: "", saved: false }])}>
            <Plus size="sm" />
            {copy.add}
          </Button>
        }
      >
        {rows.map(({ id, name, value, saved }, index) => (
          <SettingsSecretRow
            key={id}
            sourceControl={null}
            keyControl={null}
            valueControl={
              <Stack gap="xs">
                <Input id={index === 0 ? fieldId : undefined} aria-label={copy.name} placeholder={copy.name}
                  aria-describedby={description} aria-invalid={Boolean(error)} value={name} disabled={disabled}
                  onChange={(event) => onChange(rows.map((row) => row.id === id ? { ...row, name: event.target.value } : row))} />
                <Input type="password" aria-label={copy.value} placeholder={saved && name === id ? copy.saved : copy.value}
                  autoComplete="off" value={value} disabled={disabled}
                  onChange={(event) => onChange(rows.map((row) => row.id === id ? { ...row, value: event.target.value } : row))} />
              </Stack>
            }
            actionControl={
              <IconButton type="button" label={copy.remove} disabled={disabled}
                onClick={() => onChange(rows.filter((row) => row.id !== id))}>
                <Trash2 size="sm" />
              </IconButton>
            }
          />
        ))}
      </SettingsSecretRows>
      <Typo.Caption id={`${fieldId}-hint`} tone="secondary">{copy.hint}</Typo.Caption>
      {error && <FieldError id={`${fieldId}-error`}>{error}</FieldError>}
    </Stack>
  );
}
