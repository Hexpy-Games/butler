import type { DsBaseProps } from "../../lib/dsProps";
import type { FormHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import styles from "./ComposerCard.module.css";

export interface ComposerCardProps extends DsBaseProps<FormHTMLAttributes<HTMLFormElement>> {
  large?: boolean;
  floating?: boolean;
  dropActive?: boolean;
  adjunct?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  controls?: ReactNode;
}

export function ComposerCard({
  large = false,
  floating = false,
  dropActive = false,
  adjunct,
  notice,
  children,
  className,
  containerRef,
  controls,
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
        className={cn(tintedGlassSurfaceClassName, styles.card, className)}
        data-radius="composer"
        data-drop-active={dropActive ? "true" : undefined}
        data-test-class="composer-card"
        {...props}
      >
        {adjunct ? (
          <div className={styles.adjunct} data-test-class="composer-adjunct-slot">
            {adjunct}
          </div>
        ) : null}
        {children}
      </form>
      {controls ? <div className={styles.controls} data-test-class="composer-controls-slot">{controls}</div> : null}
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

/** Send/stop centers on the editor's last line as the draft grows. */
export function ComposerCardInlineAction({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className={styles.inlineAction} data-slot="composer-inline-action">
      <div className={styles.editorColumn}>{children}</div>
      <div className={styles.action}>{action}</div>
    </div>
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
