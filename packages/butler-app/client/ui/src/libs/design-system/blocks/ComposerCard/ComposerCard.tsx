import type {
  ButtonHTMLAttributes,
  FormHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { createContext, forwardRef, useContext } from "react";
import { Collapsible } from "../../components/Collapsible";
import { SendHorizontal, Square } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import styles from "./ComposerCard.module.css";

export interface ComposerCardProps extends FormHTMLAttributes<HTMLFormElement> {
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
      </form>
    </div>
  );
}

export const ComposerCardTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
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
    <Collapsible open={expanded} keepMounted="focusable" className={styles.expandedBody} data-slot="composer-expanded-body">
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
}: ButtonHTMLAttributes<HTMLButtonElement>) {
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

export interface ComposerSendButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  mode?: "send" | "stop";
  busy?: boolean;
}

export function ComposerSendButton({
  mode = "send",
  busy = false,
  disabled,
  className,
  children,
  ...props
}: ComposerSendButtonProps) {
  return (
    <button
      className={cn(styles.sendButton, mode === "stop" && styles.stop, className)}
      data-test-class="composer-send-button"
      type={!busy && mode === "send" ? "submit" : "button"}
      {...props}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={16} /> : children ?? (mode === "stop" ? <Square size="sm" /> : <SendHorizontal size="md" />)}
    </button>
  );
}
