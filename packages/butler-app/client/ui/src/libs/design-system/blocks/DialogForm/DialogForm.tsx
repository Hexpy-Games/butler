import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./DialogForm.module.css";

export interface DialogFormProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
}

export function DialogForm({
  title,
  description,
  children,
  footer,
  onSubmit,
}: DialogFormProps) {
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <Stack gap="xs">
        <Typo.PanelTitle className={styles.title}>{title}</Typo.PanelTitle>
        {description ? <Typo.Body className={styles.description}>{description}</Typo.Body> : null}
      </Stack>
      <Stack gap="md">{children}</Stack>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </form>
  );
}
