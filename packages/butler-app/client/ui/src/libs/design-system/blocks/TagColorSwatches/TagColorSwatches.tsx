import { useRef, type KeyboardEvent } from "react";
import { CheckIcon } from "../../components/Icons";
import { tagLabelTones, type TagLabelTone } from "../../components/Tag/tagTones";
import { Tooltip } from "../../components/Tooltip";
import styles from "./TagColorSwatches.module.css";

export interface TagColorSwatchesProps {
  /** The chosen tone (store this name, never a color value). */
  value: TagLabelTone;
  onValueChange: (tone: TagLabelTone) => void;
  /** Each tone's name ("Blue", "파랑"): the swatch's accessible name and tooltip. */
  labels: Record<TagLabelTone, string>;
  /** Accessible name of the group ("Color"). */
  ariaLabel: string;
  /** The tones offered, in order; every label tone by default. */
  tones?: readonly TagLabelTone[];
  "data-test-class"?: string;
}

const STEP: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Picks a Tag label tone: a radiogroup of round swatches in each tone's
 * Tag colors. Arrow keys move and select (Home/End jump); only the chosen
 * swatch is in the tab order. Rings draw inside each swatch's box, so no
 * clipping container cuts them.
 */
export function TagColorSwatches({
  value,
  onValueChange,
  labels,
  ariaLabel,
  tones = tagLabelTones,
  "data-test-class": dataTestClass,
}: TagColorSwatchesProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndex = Math.max(0, tones.indexOf(value));

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = STEP[event.key];
    const target = event.key === "Home" ? 0 : event.key === "End" ? tones.length - 1
      : step === undefined ? null : (index + step + tones.length) % tones.length;
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
    const tone = tones[target];
    if (tone && tone !== value) onValueChange(tone);
  };

  return (
    <div className={styles.group} role="radiogroup" aria-label={ariaLabel} data-slot="tag-color-swatches" data-test-class={dataTestClass}>
      {tones.map((tone, index) => {
        const checked = tone === value;
        return (
          <Tooltip key={tone} label={labels[tone]}>
            <button
              ref={(node) => { refs.current[index] = node; }}
              className={styles.swatch}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={labels[tone]}
              data-state={checked ? "on" : "off"}
              data-tone={tone}
              tabIndex={index === focusIndex ? 0 : -1}
              onClick={() => { if (!checked) onValueChange(tone); }}
              onKeyDown={(event) => move(event, index)}
            >
              <span className={styles.chip} aria-hidden="true">{checked ? <CheckIcon size="sm" /> : null}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
