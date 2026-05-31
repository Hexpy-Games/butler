import { useEffect, useId, useRef, useState } from "react";
import { Input, Slider, Typo } from "@/butler-ds";
import { SettingsField, Stack } from "@/butler-ds";
import { clampedPercent } from "./settingsUtils";

export function SettingsPercentInput({
  label,
  value,
  description,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  description: string;
  disabled?: boolean;
  onCommit: (value: string) => Promise<boolean>;
}) {
  const descriptionId = useId();
  const [text, setText] = useState(value);
  const committedValue = useRef(value);

  useEffect(() => {
    setText(value);
    committedValue.current = value;
  }, [value]);

  async function commit(raw: string) {
    const percent = String(clampedPercent(raw));
    if (percent === committedValue.current) {
      setText(percent);
      return;
    }
    setText(percent);
    committedValue.current = percent;
    const saved = await onCommit(percent);
    if (!saved) {
      committedValue.current = value;
      setText(value);
    }
  }

  const sliderValue = clampedPercent(text);

  return (
    <SettingsField
      data-test-class="settings-field"
      label={label}
      description={description}
      descriptionId={descriptionId}
      control={<Stack gap="2">
        <Input
          aria-label={`${label} percent value`}
          aria-describedby={descriptionId}
          disabled={disabled}
          inputMode="numeric"
          value={text}
          onBlur={(event) => void commit(event.target.value)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <Slider
          aria-describedby={descriptionId}
          aria-label={`${label} percent slider`}
          disabled={disabled}
          max={100}
          min={0}
          onKeyUp={(event) => void commit(event.currentTarget.value)}
          onMouseUp={(event) => void commit(event.currentTarget.value)}
          onTouchEnd={(event) => void commit(event.currentTarget.value)}
          onValueChange={(value) => setText(String(value))}
          step={5}
          value={sliderValue}
        />
        <Typo.Caption>{sliderValue}%</Typo.Caption>
      </Stack>}
    />
  );
}
