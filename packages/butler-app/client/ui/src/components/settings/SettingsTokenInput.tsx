import { useEffect, useId, useState } from "react";
import { Input, SettingsField, Slider, Stack, Typo } from "@/butler-ds";

export function SettingsTokenInput({
  label,
  value,
  min,
  max,
  description,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  description: string;
  onCommit: (value: number, clamped: boolean) => void;
}) {
  const descriptionId = useId();
  const sliderId = useId();
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  function parseTokenLimit(raw: string): number | null {
    const normalized = raw.replace(/[,_\s]/gu, "");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(min, Math.min(Math.trunc(parsed), max));
  }

  function commit(raw: string) {
    const parsed = parseTokenLimit(raw);
    if (!parsed) {
      setText(String(value));
      return;
    }
    const numeric = Number(raw.replace(/[,_\s]/gu, ""));
    const clamped = Number.isFinite(numeric) && Math.trunc(numeric) !== parsed;
    setText(String(parsed));
    onCommit(parsed, clamped);
  }

  const sliderValue = parseTokenLimit(text) ?? value;
  const formattedMax = max.toLocaleString("en-US");

  return (
    <SettingsField
      data-test-class="settings-field"
      label={label}
      description={description}
      descriptionId={descriptionId}
      control={
        <Stack gap="2">
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            inputMode="numeric"
            aria-describedby={descriptionId}
            aria-label={label}
          />
          <Slider
            aria-describedby={descriptionId}
            aria-label={`${label} slider`}
            id={sliderId}
            max={max}
            min={min}
            onKeyUp={(event) => commit(event.currentTarget.value)}
            onMouseUp={(event) => commit(event.currentTarget.value)}
            onTouchEnd={(event) => commit(event.currentTarget.value)}
            onValueChange={(nextValue) => setText(String(nextValue))}
            step={1000}
            value={sliderValue}
          />
          <Typo.Caption>
            {sliderValue.toLocaleString("en-US")} / {formattedMax}
          </Typo.Caption>
        </Stack>
      }
    />
  );
}
