import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { useMemo, useState, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { PromptFluidBackground } from "./PromptFluidBackground";
import {
  PromptFluidPaletteControl,
  type PromptFluidPaletteOption,
} from "./PromptFluidPaletteControl";
import { PromptSuggestionCard } from "./PromptSuggestionCard";
import type { FluidPalette, FluidTone, FluidVariant } from "./promptFluid";
import styles from "./PromptSuggestionList.module.css";
import { dsClass } from "../../lib/internal";

export interface PromptSuggestionItem {
  id: string;
  description: string;
  title: string;
  meta?: string;
  text: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface PromptSuggestionListProps extends DsPrivateStyleProps {
  title: ReactNode;
  suggestions: PromptSuggestionItem[];
  description?: ReactNode;
  fluidBackground?: boolean;
  fluidPalette?: FluidPalette;
  fluidPaletteOptions?: readonly PromptFluidPaletteOption[];
  /** Omit to follow the nearest theme scope. */
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
  fluidTone,
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
  const railFadeRef = useScrollEdges("x");

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
        {moment || titleIcon ? (
          <div className={styles.metaRow}>
            {titleIcon ? (
              <span
                className={styles.compactTitleIcon}
                aria-hidden="true"
                data-slot="prompt-suggestion-compact-title-icon"
              >
                {titleIcon}
              </span>
            ) : null}
            {moment ? (
              <Typo.Caption
                className={dsClass(styles.moment)}
                data-slot="prompt-suggestion-moment"
              >
                {moment}
              </Typo.Caption>
            ) : null}
          </div>
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
            <Typo.H1 as="h2" className={dsClass(styles.title)}>
              {title}
            </Typo.H1>
            {description ? (
              <Typo.Body className={dsClass(styles.description)}>
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
        ref={railFadeRef}
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
