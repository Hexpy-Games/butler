import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DialogDescription, DialogTitle } from "../../components/Dialog";
import { SettingsFieldScopeProvider } from "../SettingsField/settingsFieldScope";
import styles from "./DialogForm.module.css";
import { dsClass } from "../../lib/internal";

export interface DialogFormProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  /**
   * Inside a Dialog: the visible title and description become the dialog's
   * DialogTitle and DialogDescription (no separate sr-only title needed).
   */
  dialog?: boolean;
  /** Marks the form busy while it submits. */
  busy?: boolean;
}

export function DialogForm({
  title,
  description,
  children,
  footer,
  onSubmit,
  dialog = false,
  busy,
}: DialogFormProps) {
  const heading = <Typo.PanelTitle className={dsClass(styles.title)}>{title}</Typo.PanelTitle>;
  const body = description ? <Typo.Body className={dsClass(styles.description)}>{description}</Typo.Body> : null;
  return (
    <form
      aria-busy={busy || undefined}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <Stack gap="xs">
        {dialog ? <DialogTitle asChild>{heading}</DialogTitle> : heading}
        {body && dialog ? <DialogDescription asChild>{body}</DialogDescription> : body}
      </Stack>
      <Stack gap="md"><SettingsFieldScopeProvider>{children}</SettingsFieldScopeProvider></Stack>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </form>
  );
}
