import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Inline,
  SettingsField,
  Stack,
  Tooltip,
} from "@/butler-ds";
import { useId, type ReactNode } from "react";

interface SettingsOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  group?: string;
  /** Decorative glyph before the label (a service logo). */
  icon?: ReactNode;
}

export function SettingsSelect({
  label,
  settingId,
  description,
  id,
  disabled,
  disabledReason,
  controlWidth,
  action,
  meta,
  triggerTestClass,
  value,
  onChange,
  options,
}: {
  label: string;
  settingId?: string;
  description?: string;
  id?: string;
  disabled?: boolean;
  /** Disables the control and names why in a tooltip on it. */
  disabledReason?: string;
  controlWidth?: "default" | "full";
  action?: ReactNode;
  /** Facts about the chosen value, under the control. */
  meta?: ReactNode;
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

  const inactive = Boolean(disabled || disabledReason);
  const trigger = (
    <SelectTrigger
      id={controlId}
      aria-describedby={description ? descriptionId : undefined}
      data-test-class={triggerTestClass}
      data-multiline={selectedHasDescription ? "true" : undefined}
      disabled={inactive}
    >
      <SelectValue icon={selectedOption?.icon}>
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
  );
  const selectControl = (
    <Select value={value} onValueChange={onChange} disabled={inactive}>
      {/* Beside the trigger, clear of the label and description stacked above it. */}
      {disabledReason ? <Tooltip label={disabledReason} side="right">{trigger}</Tooltip> : trigger}
      <SelectContent>
        {optionGroups(options).map(([group, items]) => <SelectGroup key={group}>
          {group && <SelectLabel>{group}</SelectLabel>}
          {items.map(option => <SettingsSelectOption key={option.value} option={option} />)}
        </SelectGroup>)}
      </SelectContent>
    </Select>
  );
  const control = action ? (
    <Inline>
      <Stack.Item basis="lg" minWidth="0">{selectControl}</Stack.Item>
      <Stack.Item shrink={false}>{action}</Stack.Item>
    </Inline>
  ) : (
    selectControl
  );

  return (
    <SettingsField
      settingId={settingId}
      data-test-class="settings-field"
      id={controlId}
      label={label}
      description={description}
      descriptionId={description ? descriptionId : undefined}
      controlWidth={controlWidth}
      control={control}
      meta={meta}
    />
  );
}

function optionGroups(options: SettingsOption[]): Array<[string, SettingsOption[]]> {
  const groups = new Map<string, SettingsOption[]>();
  for (const option of options) {
    const key = option.group ?? "";
    groups.set(key, [...groups.get(key) ?? [], option]);
  }
  return [...groups];
}

function SettingsSelectOption({ option }: { option: SettingsOption }) {
  const item = <SelectItem value={option.value} icon={option.icon} disabled={option.disabled || Boolean(option.disabledReason)}
    textValue={option.description ? `${option.label} - ${option.description}` : option.label}>
    <span data-slot="select-item-stack"><span data-slot="select-item-label">{option.label}</span>
      {option.description && <span data-slot="select-item-description">{option.description}</span>}
    </span>
  </SelectItem>;
  return option.disabledReason ? <Tooltip label={option.disabledReason}>{item}</Tooltip> : item;
}
