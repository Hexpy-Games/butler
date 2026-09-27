import type { DsPrivateStyleProps, DsBaseProps } from "../../lib/dsProps";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import { Field } from "../../components/Field";
import { Label } from "../../components/Label";
import { Typo } from "../../components/Typo";
import { isDevBuild } from "../../lib/devBuild";
import { useSettingsFieldScope } from "./settingsFieldScope";
import styles from "./SettingsField.module.css";
import { dsClass } from "../../lib/internal";

export interface SettingsFieldProps extends DsPrivateStyleProps, DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  meta?: ReactNode;
  descriptionId?: string;
  controlWidth?: "default" | "full";
  /** Stable setting id (`data-setting-id`); settings pages declare it in their schema. */
  settingId?: string;
}

export function SettingsField({
  id,
  label,
  description,
  descriptionId,
  control,
  meta,
  controlWidth = "default",
  settingId,
  className,
  ...props
}: SettingsFieldProps) {
  const scope = useSettingsFieldScope();
  if (!scope && isDevBuild()) {
    throw new Error("SettingsField must render inside a SettingsSection (or FormSection / DialogForm).");
  }
  const generatedDescriptionId = useId();
  const effectiveDescriptionId = descriptionId ?? generatedDescriptionId;

  return (
    <Field
      className={dsClass(styles.field, className)}
      data-control-width={controlWidth}
      data-settings-field=""
      data-setting-id={settingId}
      {...props}
    >
      <div className={styles.copy}>
        <Label htmlFor={id}>{label}</Label>
        {description ? (
          <Typo.Caption
            className={dsClass(styles.description)}
            id={effectiveDescriptionId}
          >
            {description}
          </Typo.Caption>
        ) : null}
      </div>
      <div className={styles.control}>
        {control}
        {meta ? (
          <Typo.Caption className={dsClass(styles.meta)}>{meta}</Typo.Caption>
        ) : null}
      </div>
    </Field>
  );
}
