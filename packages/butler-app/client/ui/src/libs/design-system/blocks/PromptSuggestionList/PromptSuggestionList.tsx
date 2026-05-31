import { useMemo, useState, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { PromptFluidBackground } from "./PromptFluidBackground";
import {
  PromptFluidPaletteControl,
  type PromptFluidPaletteOption,
} from "./PromptFluidPaletteControl";
import { PromptSuggestionCard } from "./PromptSuggestionCard";
import type { FluidPalette, FluidTone, FluidVariant } from "./promptFluid";
import styles from "./PromptSuggestionList.module.css";

export interface PromptSuggestionItem {
  id: string;
  description: string;
  title: string;
  meta?: string;
  text: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface PromptSuggestionListProps {
  title: ReactNode;
  suggestions: PromptSuggestionItem[];
  className?: string;
  description?: ReactNode;
  fluidBackground?: boolean;
  fluidPalette?: FluidPalette;
  fluidPaletteOptions?: readonly PromptFluidPaletteOption[];
  fluidTone?: FluidTone;
  fluidVariant?: FluidVariant;
  moment?: ReactNode;
  titleIcon?: ReactNode;
}

export function PromptSuggestionList({
  title,
  suggestions,
  className,
  description,
  fluidBackground = false,
  fluidPalette,
  fluidPaletteOptions,
  fluidTone = "light",
  fluidVariant = "bloom",
  moment,
  titleIcon,
}: PromptSuggestionListProps) {
  const [fluidPaletteId, setFluidPaletteId] = useState(
    () => fluidPaletteOptions?.[0]?.id ?? "",
  );
  const selectedPaletteOption = useMemo(
    () =>
      fluidPaletteOptions?.find((option) => option.id === fluidPaletteId) ??
      fluidPaletteOptions?.[0],
    [fluidPaletteId, fluidPaletteOptions],
  );
  const titleIconState = titleIcon ? "true" : undefined;

  return (
    <section
      className={cn(styles.root, className)}
      data-test-class="new-chat-empty-state"
    >
      {fluidBackground ? (
        <PromptFluidBackground
          palette={fluidPalette ?? selectedPaletteOption?.colors}
          tone={fluidTone}
          variant={fluidVariant}
        />
      ) : null}
      <header className={styles.header} data-has-title-icon={titleIconState}>
        {moment ? (
          <Typo.Caption
            className={styles.moment}
            data-slot="prompt-suggestion-moment"
          >
            {moment}
          </Typo.Caption>
        ) : null}
        <div className={styles.titleRow} data-has-title-icon={titleIconState}>
          {titleIcon ? (
            <span
              className={styles.titleIcon}
              aria-hidden="true"
              data-slot="prompt-suggestion-title-icon"
            >
              {titleIcon}
            </span>
          ) : null}
          <div
            className={styles.titleCopy}
            data-slot="prompt-suggestion-title-copy"
          >
            <Typo.H1 as="h2" className={styles.title}>
              {title}
            </Typo.H1>
            {description ? (
              <Typo.Body className={styles.description}>
                {description}
              </Typo.Body>
            ) : null}
          </div>
        </div>
        {fluidPaletteOptions && fluidPaletteOptions.length > 1 ? (
          <PromptFluidPaletteControl
            onSelect={setFluidPaletteId}
            options={fluidPaletteOptions}
            selectedId={selectedPaletteOption?.id}
          />
        ) : null}
      </header>
      <div
        className={styles.railViewport}
        data-test-class="new-chat-suggestion-rail"
      >
        <div className={styles.grid} data-test-class="new-chat-suggestions">
          {suggestions.map((suggestion, index) => (
            <PromptSuggestionCard
              key={suggestion.id}
              index={index}
              suggestion={suggestion}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
