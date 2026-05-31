import type { CSSProperties } from "react";
import type { FluidPalette, FluidRgb } from "./promptFluid";
import styles from "./PromptSuggestionList.module.css";

export interface PromptFluidPaletteOption {
  id: string;
  colors: FluidPalette;
  label: string;
}

interface PromptFluidPaletteControlProps {
  options: readonly PromptFluidPaletteOption[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

function rgbStyle(color: FluidRgb): CSSProperties {
  return { backgroundColor: `rgb(${color[0]} ${color[1]} ${color[2]})` };
}

export function PromptFluidPaletteControl({
  options,
  selectedId,
  onSelect,
}: PromptFluidPaletteControlProps) {
  return (
    <div
      className={styles.paletteControl}
      data-test-class="new-chat-fluid-palette-selector"
    >
      {options.map((option) => (
        <button
          key={option.id}
          aria-pressed={selectedId === option.id}
          className={styles.paletteOption}
          data-active={selectedId === option.id ? "true" : undefined}
          onClick={() => onSelect(option.id)}
          type="button"
        >
          <span className={styles.paletteSwatches} aria-hidden="true">
            {option.colors.slice(0, 4).map((color, index) => (
              <span
                key={`${option.id}-${index}`}
                className={styles.paletteSwatch}
                style={rgbStyle(color)}
              />
            ))}
          </span>
          <span className={styles.paletteLabel}>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
