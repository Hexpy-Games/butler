import type { ReactNode } from "react";
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

/**
 * Label over control on the settings field ramp: label to control uses the
 * control gap, help/error stay attached to the control with the copy gap,
 * and rows are spaced by their container (FormSection uses the field gap).
 */
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
    <div className={cn(styles.row, className)} data-slot="form-row">
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className={styles.control}>
        {children}
        {help && !hasError && (
          <Typo.Caption className={styles.help}>{help}</Typo.Caption>
        )}
        {hasError && (
          <Typo.Caption className={styles.error}>{error}</Typo.Caption>
        )}
      </div>
    </div>
  );
}
