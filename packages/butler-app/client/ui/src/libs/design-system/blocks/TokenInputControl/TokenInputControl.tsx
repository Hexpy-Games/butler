import { useEffect, useState } from "react";
import { Input } from "../../components/Input";
import { Slider } from "../../components/Slider";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";

export interface TokenInputControlProps {
  id?: string;
  /** Committed token budget. */
  value: number;
  min: number;
  max: number;
  /** Slider step in tokens. */
  step?: number;
  disabled?: boolean;
  /** Accessible name of the number input. */
  inputLabel: string;
  /** Accessible name of the slider. */
  sliderLabel: string;
  /** Id of the helper text both halves describe themselves with. */
  describedBy?: string;
  /** Called with the committed budget; `clamped` is true when the typed value was out of range. */
  onCommit: (value: number, clamped: boolean) => void;
}

function parseTokens(raw: string): number | null {
  const parsed = Number(raw.replace(/[,_\s]/gu, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Parse a typed budget (commas, underscores and spaces allowed) and clamp it to the range. */
export function resolveTokenCommit(
  raw: string,
  committed: number,
  { min, max }: { min: number; max: number },
): { text: string; commit: { value: number; clamped: boolean } | null } {
  const parsed = parseTokens(raw);
  if (!parsed) return { text: String(committed), commit: null };
  const value = Math.max(min, Math.min(parsed, max));
  return { text: String(value), commit: { value, clamped: value !== parsed } };
}

/** A token budget setting: number input, slider and a `value / max` readout. */
export function TokenInputControl({
  id,
  value,
  min,
  max,
  step = 1000,
  disabled,
  inputLabel,
  sliderLabel,
  describedBy,
  onCommit,
}: TokenInputControlProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commit(raw: string) {
    const next = resolveTokenCommit(raw, value, { min, max });
    setText(next.text);
    if (next.commit) onCommit(next.commit.value, next.commit.clamped);
  }

  const parsed = parseTokens(text);
  const sliderValue = parsed ? Math.max(min, Math.min(parsed, max)) : value;

  return (
    <Stack gap="sm" data-slot="token-input-control">
      <Input
        id={id}
        aria-label={inputLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        inputMode="numeric"
        value={text}
        onBlur={(event) => commit(event.target.value)}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <Slider
        aria-describedby={describedBy}
        aria-label={sliderLabel}
        disabled={disabled}
        max={max}
        min={min}
        onKeyUp={(event) => commit(event.currentTarget.value)}
        onMouseUp={(event) => commit(event.currentTarget.value)}
        onTouchEnd={(event) => commit(event.currentTarget.value)}
        onValueChange={(next) => setText(String(next))}
        step={step}
        value={sliderValue}
      />
      <Typo.Caption>
        {sliderValue.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
      </Typo.Caption>
    </Stack>
  );
}
