import { useId } from "react";
import { SettingsField, Switch } from "@/butler-ds";

export function SettingsSwitch({
  label,
  settingId,
  description,
  id,
  checked,
  onChange,
}: {
  label: string;
  settingId?: string;
  description?: string;
  id?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = useId();

  return (
    <SettingsField
      settingId={settingId}
      data-test-class="toggle-field settings-switch-row"
      id={controlId}
      label={label}
      description={description}
      descriptionId={description ? descriptionId : undefined}
      control={
        <Switch
          id={controlId}
          aria-describedby={description ? descriptionId : undefined}
          checked={checked}
          onCheckedChange={onChange}
        />
      }
    />
  );
}
