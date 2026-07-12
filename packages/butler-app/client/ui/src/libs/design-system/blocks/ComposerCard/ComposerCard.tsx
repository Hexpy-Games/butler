import type {
  ButtonHTMLAttributes,
  FormHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";
import { forwardRef } from "react";
import { SendHorizontal, Square } from "../../components/Icons";
import { Switch } from "../../components/Switch";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import styles from "./ComposerCard.module.css";

export interface ComposerCardProps extends FormHTMLAttributes<HTMLFormElement> {
  large?: boolean;
  floating?: boolean;
  adjunct?: ReactNode;
  children: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  expanded?: boolean;
}

export function ComposerCard({
  large = false,
  floating = false,
  adjunct,
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
      <form
        className={cn(tintedGlassSurfaceClassName, styles.card, className)}
        data-radius="composer"
        data-expanded={expanded}
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

export function ComposerCardExpandedBody({ children }: { children: ReactNode }) {
  return (
    <div className={styles.expandedBody} data-slot="composer-expanded-body">
      <div className={styles.expandedBodyInner}>{children}</div>
    </div>
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
  return <span className={styles.spacer} aria-hidden="true" />;
}

export function ComposerPlanToggle({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: ReactNode;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.planToggle} data-test-class="plan-switch">
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
      <span>{label}</span>
    </label>
  );
}

export interface ComposerSendButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  mode?: "send" | "stop";
}

export function ComposerSendButton({
  mode = "send",
  className,
  children,
  ...props
}: ComposerSendButtonProps) {
  return (
    <button
      className={cn(styles.sendButton, mode === "stop" && styles.stop, className)}
      data-test-class="composer-send-button"
      type={mode === "send" ? "submit" : "button"}
      {...props}
    >
      {children ?? (mode === "stop" ? <Square size={14} /> : <SendHorizontal size={16} />)}
    </button>
  );
}
