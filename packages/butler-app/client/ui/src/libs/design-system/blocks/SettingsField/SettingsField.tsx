import type { DsPrivateStyleProps, DsBaseProps } from "../../lib/dsProps";
import { cloneElement, isValidElement, useId, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { Field, FieldError } from "../../components/Field";
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
  /** Localized validation message under the control; the control becomes aria-invalid and is described by it. */
  error?: ReactNode;
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
  error,
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
  const errorId = `${effectiveDescriptionId}-error`;
  const describedControl = describeControl(
    control,
    [description ? effectiveDescriptionId : undefined, error ? errorId : undefined],
    Boolean(error),
  );

  return (
    <Field
      className={dsClass(styles.field, className)}
      data-invalid={error ? "true" : undefined}
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
        {describedControl}
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        {meta ? (
          <Typo.Caption className={dsClass(styles.meta)}>{meta}</Typo.Caption>
        ) : null}
      </div>
    </Field>
  );
}

interface DescribedControlProps {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

/** Merges the description and error ids into the control's aria-describedby (no duplicates) and sets aria-invalid on error. */
function describeControl(control: ReactNode, ids: (string | undefined)[], invalid: boolean): ReactNode {
  if (!isValidElement<DescribedControlProps>(control) || !ids.some(Boolean)) return control;
  const own = control.props["aria-describedby"]?.split(/\s+/u) ?? [];
  const describedBy = [...new Set([...own, ...ids])].filter((value): value is string => Boolean(value)).join(" ");
  return cloneElement(control as ReactElement<DescribedControlProps>, {
    "aria-describedby": describedBy,
    "aria-invalid": invalid ? true : control.props["aria-invalid"],
  });
}
