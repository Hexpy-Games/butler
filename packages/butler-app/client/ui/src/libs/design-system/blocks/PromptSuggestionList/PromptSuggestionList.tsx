import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { useCallback, useState, type ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { Card } from "../../components/Card";
import { Box } from "../../components/Box";
import { Stack } from "../../components/Stack";
import { cn } from "../../lib/utils";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { Wallpaper, type WallpaperMotion, type WallpaperSource, type WallpaperTone } from "../Wallpaper";
import { PromptSuggestionCard } from "./PromptSuggestionCard";
import { usePromptContentRect } from "./usePromptContentRect";
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
  /** Full-screen wallpaper behind the prompt; omit or `none` for a plain background. */
  wallpaper?: WallpaperSource;
  /** `paused` holds a still frame (the user's pause). */
  wallpaperMotion?: WallpaperMotion;
  /** Hold a still frame while the device runs on battery. */
  wallpaperPauseOnBattery?: boolean;
  /** Omit to follow the nearest theme scope. */
  wallpaperTone?: WallpaperTone;
  moment?: ReactNode;
  titleIcon?: ReactNode;
}

export function PromptSuggestionList({
  title,
  suggestions,
  className,
  description,
  wallpaper,
  wallpaperMotion,
  wallpaperPauseOnBattery,
  wallpaperTone,
  moment,
  titleIcon,
}: PromptSuggestionListProps) {
  const titleIconState = titleIcon ? "true" : undefined;
  const railFadeRef = useScrollEdges("x");
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const railRef = useCallback((node: HTMLDivElement | null) => {
    setRail(node);
    return railFadeRef(node);
  }, [railFadeRef]);
  // Modules keep the headline and cards readable (u_contentRect), as they are composed around them.
  const contentRect = usePromptContentRect(wallpaper ? header : null, rail, grid);

  return (
    <section
      className={cn(styles.root, className)}
      data-test-class="new-chat-empty-state"
    >
      {wallpaper ? (
        <Wallpaper
          contentRect={contentRect}
          dataTestClass="new-chat-fluid-gradient"
          motion={wallpaperMotion}
          pauseOnBattery={wallpaperPauseOnBattery}
          source={wallpaper}
          tone={wallpaperTone}
        />
      ) : null}
      <header className={styles.header} data-has-title-icon={titleIconState} ref={setHeader}>
        <Card className={dsClass(styles.headerSurface)} padding="none"><Box padding="lg"><Stack gap="md">
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
        </Stack></Box></Card>
      </header>
      <div
        ref={railRef}
        className={styles.railViewport}
        data-test-class="new-chat-suggestion-rail"
      >
        <div className={styles.grid} data-test-class="new-chat-suggestions" ref={setGrid}>
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
