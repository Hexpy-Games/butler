import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsField,
  Stack,
} from "@/butler-ds";
import { useId, type ReactNode } from "react";

interface SettingsOption {
  value: string;
  label: string;
  description?: string;
}

export function SettingsSelect({
  label,
  description,
  id,
  disabled,
  controlWidth,
  action,
  triggerTestClass,
  value,
  onChange,
  options,
}: {
  label: string;
  description?: string;
  id?: string;
  disabled?: boolean;
  controlWidth?: "default" | "full";
  action?: ReactNode;
  triggerTestClass?: string;
  value: string;
  onChange: (value: string) => void;
  options: SettingsOption[];
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = useId();
  const selectedOption = options.find((option) => option.value === value);
  const selectedHasDescription = Boolean(selectedOption?.description);

  const selectControl = (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        id={controlId}
        aria-describedby={description ? descriptionId : undefined}
        data-test-class={triggerTestClass}
        data-multiline={selectedHasDescription ? "true" : undefined}
        disabled={disabled}
      >
        <SelectValue>
          {selectedOption && (
            <span data-slot="select-value-stack">
              <span data-slot="select-value-label">{selectedOption.label}</span>
              {selectedOption.description && (
                <span data-slot="select-value-description">
                  {selectedOption.description}
                </span>
              )}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              textValue={
                option.description
                  ? `${option.label} - ${option.description}`
                  : option.label
              }
            >
              <span data-slot="select-item-stack">
                <span data-slot="select-item-label">{option.label}</span>
                {option.description && (
                  <span data-slot="select-item-description">
                    {option.description}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
  const control = action ? (
    <Stack
      align="row"
      cross="center"
      gap="sm"
      wrap
      style={{ width: "100%", maxWidth: "100%" }}
    >
      <div
        style={{ flex: "0 1 460px", width: "min(100%, 460px)", minWidth: 0 }}
      >
        {selectControl}
      </div>
      <div style={{ flex: "0 0 auto" }}>{action}</div>
    </Stack>
  ) : (
    selectControl
  );

  return (
    <SettingsField
      data-test-class="settings-field"
      id={controlId}
      label={label}
      description={description}
      descriptionId={description ? descriptionId : undefined}
      controlWidth={controlWidth}
      control={control}
    />
  );
}
