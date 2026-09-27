import { useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  options: SegmentedControlOption[];
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the group, e.g. "Period". */
  ariaLabel: string;
  size?: "sm" | "default";
}

/**
 * A compact single-choice radiogroup for a secondary choice inside a page
 * (period, dataset, mode). Tabs switch panels; this switches what a panel shows.
 */
export function SegmentedControl({ options, value, onValueChange, ariaLabel, size = "default" }: SegmentedControlProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : enabled[0]?.index ?? 0;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const edge = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) : undefined;
    if (!step && !edge) return;
    event.preventDefault();
    const position = enabled.findIndex((item) => item.index === index);
    const target = edge ?? enabled[(position + step + enabled.length) % enabled.length];
    if (!target) return;
    refs.current[target.index]?.focus();
    onValueChange(target.option.value);
  };

  return (
    <div className={styles.group} role="radiogroup" aria-label={ariaLabel} data-size={size} data-slot="segmented-control">
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => { refs.current[index] = node; }}
            className={styles.item}
            type="button"
            role="radio"
            aria-checked={checked}
            data-state={checked ? "on" : "off"}
            disabled={option.disabled}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => { if (!checked) onValueChange(option.value); }}
            onKeyDown={(event) => move(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
