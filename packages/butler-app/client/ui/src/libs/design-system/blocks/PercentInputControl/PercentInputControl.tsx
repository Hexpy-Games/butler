import { useEffect, useRef, useState } from "react";
import { Input } from "../../components/Input";
import { Slider } from "../../components/Slider";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";

export interface PercentInputControlProps {
  id?: string;
  /** Committed percentage. */
  value: number;
  min?: number;
  max?: number;
  /** Slider step; typed values keep whole-percent precision. */
  step?: number;
  disabled?: boolean;
  /** Accessible name of the number input. */
  inputLabel: string;
  /** Accessible name of the slider. */
  sliderLabel: string;
  /** Id of the helper text both halves describe themselves with. */
  describedBy?: string;
  /**
   * Called when a changed value is committed (blur, Enter or slider release).
   * Resolve `false` to roll the control back to `value`.
   */
  onCommit: (value: number) => void | boolean | Promise<boolean | void>;
}

/** Clamp and round a typed percentage; `commit` is null when nothing changed. */
export function resolvePercentCommit(
  raw: string,
  committed: number,
  { min, max }: { min: number; max: number },
): { text: string; commit: number | null } {
  const parsed = Number(raw);
  const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : min;
  return { text: String(next), commit: next === committed ? null : next };
}

/** A percentage setting: number input, slider and a live percent readout. */
export function PercentInputControl({
  id,
  value,
  min = 0,
  max = 100,
  step = 5,
  disabled,
  inputLabel,
  sliderLabel,
  describedBy,
  onCommit,
}: PercentInputControlProps) {
  const [text, setText] = useState(String(value));
  const committed = useRef(value);

  useEffect(() => {
    setText(String(value));
    committed.current = value;
  }, [value]);

  async function commit(raw: string) {
    const next = resolvePercentCommit(raw, committed.current, { min, max });
    setText(next.text);
    if (next.commit === null) return;
    committed.current = next.commit;
    if ((await onCommit(next.commit)) === false) {
      committed.current = value;
      setText(String(value));
    }
  }

  const parsed = Number(text);
  const sliderValue = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : min;

  return (
    <Stack gap="sm" data-slot="percent-input-control">
      <Input
        id={id}
        aria-label={inputLabel}
        aria-describedby={describedBy}
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
        aria-describedby={describedBy}
        aria-label={sliderLabel}
        disabled={disabled}
        max={max}
        min={min}
        onKeyUp={(event) => void commit(event.currentTarget.value)}
        onMouseUp={(event) => void commit(event.currentTarget.value)}
        onTouchEnd={(event) => void commit(event.currentTarget.value)}
        onValueChange={(next) => setText(String(next))}
        step={step}
        value={sliderValue}
      />
      <Typo.Caption>{sliderValue}%</Typo.Caption>
    </Stack>
  );
}
