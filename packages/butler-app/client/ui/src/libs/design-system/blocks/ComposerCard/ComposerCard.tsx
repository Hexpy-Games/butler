import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, FormHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { createContext, forwardRef, useContext } from "react";
import { Collapsible } from "../../components/Collapsible";
import { TintedGlass } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import styles from "./ComposerCard.module.css";
import { dsClass } from "../../lib/internal";

export interface ComposerCardProps extends DsBaseProps<FormHTMLAttributes<HTMLFormElement>> {
  large?: boolean;
  floating?: boolean;
  dropActive?: boolean;
  adjunct?: ReactNode;
  notice?: ReactNode;
  controls?: ReactNode;
  panel?: ReactNode;
  children: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  expanded?: boolean;
}

const ComposerExpandedContext = createContext(true);

export function ComposerCard({
  large = false,
  floating = false,
  dropActive = false,
  adjunct,
  notice,
  controls,
  panel,
  children,
  className,
  containerRef,
  expanded = true,
  ...props
}: ComposerCardProps) {
  return (
    <div
      className={cn(styles.wrap, floating && styles.floating, large && styles.large)}
      data-test-class={`composer-wrap${large ? " large" : ""}`}
      ref={containerRef}
    >
      {notice ? (
        <div className={styles.notice} data-test-class="composer-notice-slot">
          {notice}
        </div>
      ) : null}
      <form
        className={cn(styles.card, className)}
        data-drop-active={dropActive ? "true" : undefined}
        data-expanded={expanded}
        data-test-class="composer-card"
        {...props}
      >
        {adjunct ? (
          <TintedGlass padding="none" className={dsClass(styles.adjunct)} data-test-class="composer-adjunct-slot">
            {adjunct}
          </TintedGlass>
        ) : null}
        {panel ? <TintedGlass padding="none" data-slot="composer-panel">{panel}</TintedGlass> : null}
        <ComposerExpandedContext.Provider value={expanded}>
          <TintedGlass radius="composer" padding="none" className={dsClass(styles.input)} data-slot="composer-input">
            {children}
          </TintedGlass>
        </ComposerExpandedContext.Provider>
        {controls ? <TintedGlass radius="pill" padding="none" className={dsClass(styles.controls)} data-slot="composer-controls">
          {controls}
        </TintedGlass> : null}
      </form>
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

export { ComposerCardToolbar } from "./ComposerCardToolbar";

/** Editor region: Collapsible reveal, kept mounted and focusable while folded. */
export function ComposerCardExpandedBody({ children, inactive = false }: { children: ReactNode; inactive?: boolean }) {
  const expanded = useContext(ComposerExpandedContext);
  return (
    <Collapsible open={expanded} keepMounted={inactive ? true : "focusable"} className={dsClass(styles.expandedBody)} data-slot="composer-expanded-body">
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
