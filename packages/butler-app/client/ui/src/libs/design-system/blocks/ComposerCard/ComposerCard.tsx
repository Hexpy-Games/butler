import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, FormHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { createContext, forwardRef, useContext, useState } from "react";
import { Collapsible } from "../../components/Collapsible";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import { ComposerControlsVisible, ComposerControlPills, ComposerSlot, ComposerSlots } from "./ComposerCardSlots";
import styles from "./ComposerCard.module.css";
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
  ...props
}: ComposerCardProps) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [action, setAction] = useState<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  return (
    <ComposerSlots.Provider value={{ toolbar, action, preview }}>
      <div
        className={cn(styles.wrap, floating && styles.floating, large && styles.large)}
        data-test-class={`composer-wrap${large ? " large" : ""}`}
        ref={containerRef}
        data-expanded={expanded}
      >
        {notice ? (
          <div className={styles.notice} data-test-class="composer-notice-slot">
            {notice}
          </div>
        ) : null}
        <form
          className={cn(tintedGlassSurfaceClassName, styles.card, className)}
          data-radius="composer"
          data-drop-active={dropActive ? "true" : undefined}
          data-expanded={expanded}
          data-test-class="composer-card"
          {...props}
        >
          {adjunct ? (
            <div className={styles.adjunct} data-test-class="composer-adjunct-slot">
              {adjunct}
            </div>
          ) : null}
          <ComposerExpandedContext.Provider value={expanded}>{children}</ComposerExpandedContext.Provider>
          <div className={styles.previewSlot} ref={setPreview} />
          <div className={styles.actionSlot} ref={setAction} />
        </form>
        <div ref={setToolbar} data-slot="composer-toolbar-slot" />
      </div>
    </ComposerSlots.Provider>
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
    <ComposerSlot slot="toolbar">
      <div className={styles.toolbar} data-test-class="composer-toolbar">
        <ComposerControlPills>{children}</ComposerControlPills>
      </div>
    </ComposerSlot>
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
  const expanded = useContext(ComposerExpandedContext);
  return <ComposerControlsVisible.Provider value={expanded}>
    <span className={styles.expandedControls}><ComposerControlPills>{children}</ComposerControlPills></span>
  </ComposerControlsVisible.Provider>;
}

export function ComposerCardCompactPreview({
  children,
  className,
  ...props
}: DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <ComposerSlot slot="preview">
      <button
        className={cn(styles.compactPreview, className)}
        data-slot="composer-compact-preview"
        type="button"
        {...props}
      >
        {children}
      </button>
    </ComposerSlot>
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
