import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, CSSProperties, FormHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { createContext, forwardRef, useContext } from "react";
import { Collapsible } from "../../components/Collapsible";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import type { ComposerCardEdge } from "./composerEdge";
import styles from "./ComposerCard.module.css";

export type { ComposerCardEdge } from "./composerEdge";
import { dsClass } from "../../lib/internal";

export interface ComposerCardProps extends DsBaseProps<FormHTMLAttributes<HTMLFormElement>> {
  large?: boolean;
  floating?: boolean;
  dropActive?: boolean;
  adjunct?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  expanded?: boolean;
  /**
   * Art behind the card's content (e.g. `ComposerDecoration`): fills the card,
   * clipped by its radius, above the glass and below every editor and toolbar
   * node. The slot adds no scrim; the glass top highlight stays on top.
   */
  decoration?: ReactNode;
  edge?: ComposerCardEdge;
}

const ComposerExpandedContext = createContext(true);

export function ComposerCard({
  large = false,
  floating = false,
  dropActive = false,
  adjunct,
  notice,
  children,
  className,
  containerRef,
  expanded = true,
  decoration,
  edge,
  ...props
}: ComposerCardProps) {
  const reserve = edge?.reserveTop && edge.reserveTop > 0 ? edge.reserveTop : undefined;
  return (
    <div
      className={cn(styles.wrap, floating && styles.floating, large && styles.large)}
      data-edge-reserve={reserve}
      data-test-class={`composer-wrap${large ? " large" : ""}`}
      ref={containerRef}
      style={reserve ? ({ "--composer-edge-reserve": `${reserve}px` } as CSSProperties) : undefined}
    >
      {notice ? (
        <div className={styles.notice} data-test-class="composer-notice-slot">
          {notice}
        </div>
      ) : null}
      {edge?.behind ? <div aria-hidden="true" className={styles.edge} data-slot="composer-edge-behind">{edge.behind}</div> : null}
      <form
        className={cn(tintedGlassSurfaceClassName, styles.card, className)}
        data-radius="composer"
        data-drop-active={dropActive ? "true" : undefined}
        data-expanded={expanded}
        data-test-class="composer-card"
        {...props}
      >
        {decoration ? (
          <div aria-hidden="true" className={styles.background} data-slot="tinted-glass-decoration" data-test-class="composer-decoration-slot">
            {decoration}
          </div>
        ) : null}
        {adjunct ? (
          <div className={styles.adjunct} data-test-class="composer-adjunct-slot">
            {adjunct}
          </div>
        ) : null}
        <ComposerExpandedContext.Provider value={expanded}>{children}</ComposerExpandedContext.Provider>
      </form>
      {edge?.front ? <div aria-hidden="true" className={styles.edge} data-slot="composer-edge-front">{edge.front}</div> : null}
    </div>
  );
}

export const ComposerCardTextarea = forwardRef<
  HTMLTextAreaElement,
  DsBaseProps<TextareaHTMLAttributes<HTMLTextAreaElement>>
>(function ComposerCardTextarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(styles.textarea, className)}
      {...props}
    />
  );
});

export function ComposerCardToolbar({ children }: { children: ReactNode }) {
  return (
    <div className={styles.toolbar} data-test-class="composer-toolbar">
      {children}
    </div>
  );
}

/** Editor region: Collapsible reveal, kept mounted and focusable while folded. */
export function ComposerCardExpandedBody({ children }: { children: ReactNode }) {
  const expanded = useContext(ComposerExpandedContext);
  return (
    <Collapsible open={expanded} keepMounted="focusable" className={dsClass(styles.expandedBody)} data-slot="composer-expanded-body">
      {children}
    </Collapsible>
  );
}

export function ComposerCardExpandedControls({ children }: { children: ReactNode }) {
  return <span className={styles.expandedControls}>{children}</span>;
}

export function ComposerCardCompactPreview({
  children,
  className,
  ...props
}: DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button
      className={cn(styles.compactPreview, className)}
      data-slot="composer-compact-preview"
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function ComposerCardToolbarSpacer() {
  return (
    <span
      className={styles.spacer}
      aria-hidden="true"
      data-test-class="composer-toolbar-spacer"
    />
  );
}
