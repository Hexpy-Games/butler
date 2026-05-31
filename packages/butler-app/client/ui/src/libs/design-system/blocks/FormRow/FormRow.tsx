import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Label } from "../../components/Label";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./FormRow.module.css";

export interface FormRowProps {
  /** Label text */
  label: string;
  /** Input control element */
  children: ReactNode;
  /** Help text */
  help?: string;
  /** Error message */
  error?: string;
  /** HTML for attribute (links label to input) */
  htmlFor?: string;
  /** Additional CSS class */
  className?: string;
}

export function FormRow({
  label,
  children,
  help,
  error,
  htmlFor,
  className,
}: FormRowProps) {
  const hasError = !!error;

  return (
    <Stack gap="xs" className={cn(styles.row, className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help && !hasError && (
        <Typo.Caption className={styles.help}>{help}</Typo.Caption>
      )}
      {hasError && (
        <Typo.Caption className={styles.error}>{error}</Typo.Caption>
      )}
    </Stack>
  );
}
