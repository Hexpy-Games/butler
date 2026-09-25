import { useId, type HTMLAttributes, type ReactNode } from "react";
import { Field } from "../../components/Field";
import { Label } from "../../components/Label";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./SettingsField.module.css";

export interface SettingsFieldProps extends HTMLAttributes<HTMLDivElement> {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  meta?: ReactNode;
  descriptionId?: string;
  controlWidth?: "default" | "full";
  className?: string;
}

export function SettingsField({
  id,
  label,
  description,
  descriptionId,
  control,
  meta,
  controlWidth = "default",
  className,
  ...props
}: SettingsFieldProps) {
  const generatedDescriptionId = useId();
  const effectiveDescriptionId = descriptionId ?? generatedDescriptionId;

  return (
    <Field
      className={cn(styles.field, className)}
      data-control-width={controlWidth}
      {...props}
    >
      <Stack gap="xs" className={styles.copy}>
        <Label htmlFor={id}>{label}</Label>
        {description ? (
          <Typo.Caption
            className={styles.description}
            id={effectiveDescriptionId}
          >
            {description}
          </Typo.Caption>
        ) : null}
      </Stack>
      <Stack gap="xs" className={styles.control}>
        {control}
        {meta ? (
          <Typo.Caption className={styles.meta}>{meta}</Typo.Caption>
        ) : null}
      </Stack>
    </Field>
  );
}
