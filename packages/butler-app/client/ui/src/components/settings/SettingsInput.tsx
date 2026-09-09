import { useId } from "react";
import { Input } from "@/butler-ds";
import { SettingsField } from "@/butler-ds";

export function SettingsInput({
  label,
  description,
  id,
  value,
  onChange,
  onBlur,
}: {
  label: string;
  description?: string;
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = useId();

  return (
    <SettingsField
      data-test-class="settings-field"
      id={controlId}
      label={label}
      description={description}
      descriptionId={description ? descriptionId : undefined}
      control={
        <Input
          id={controlId}
          aria-describedby={description ? descriptionId : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      }
    />
  );
}
