import { Input } from "@/butler-ds";
import { SettingsField } from "@/butler-ds";

export function SettingsInput({
  label,
  value,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <SettingsField
      data-test-class="settings-field"
      label={label}
      control={<Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />}
    />
  );
}
