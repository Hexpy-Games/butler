import { useRef, type ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { MoreHorizontal } from "../../components/Icons";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/Popover";
import { dsClass } from "../../lib/internal";
import type { AdaptiveShellTheme } from "../../lib/theme";
import { useComposerOverflow } from "./useComposerOverflow";
import styles from "./ComposerCard.module.css";

/** Resize-only overflow: controls have one mounted location, never hidden duplicates. */
export function ComposerCardToolbar({ children, leading, secondary, trailing, theme, onNarrow, moreLabel = "More" }: {
  children: ReactNode; leading?: ReactNode; secondary?: ReactNode; trailing?: ReactNode; moreLabel?: string; theme?: AdaptiveShellTheme; onNarrow?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const overflow = useRef<HTMLDivElement>(null);
  const { narrow, open, changeOpen } = useComposerOverflow(ref, trigger, onNarrow);
  return <div ref={ref} className={styles.toolbar} data-test-class="composer-toolbar" role="group" aria-label="Composer controls">
    {leading}
    {!narrow && secondary ? <div className={styles.secondary} data-slot="composer-secondary">{secondary}</div> : null}
    {children}
    {narrow && secondary ? <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild><IconButton ref={trigger} label={moreLabel}><MoreHorizontal size="sm" /></IconButton></PopoverTrigger>
      <PopoverContent ref={overflow} theme={theme} side="top" align="start" width="narrow" className={dsClass(styles.overflowControls)}
        onOpenAutoFocus={() => requestAnimationFrame(() => overflow.current?.querySelector<HTMLElement>('button, select, [tabindex="0"]')?.focus())}
        onCloseAutoFocus={() => trigger.current?.focus()}>
        <div data-slot="composer-overflow" className={styles.overflowControls}>{secondary}</div>
      </PopoverContent>
    </Popover> : null}
    {trailing}
  </div>;
}
