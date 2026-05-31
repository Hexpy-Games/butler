import { SettingsField, Switch } from "@/butler-ds";

export function SettingsSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingsField
      data-test-class="toggle-field settings-switch-row"
      label={label}
      description={description}
      control={<Switch checked={checked} onCheckedChange={onChange} />}
    />
  );
}
