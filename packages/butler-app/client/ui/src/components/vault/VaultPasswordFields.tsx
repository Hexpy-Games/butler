import { useId } from "react";
import { appCopy } from "@/app/copy.ts";
import { Field, FieldDescription, FieldError, FieldLabel, Input, SettingsField, Stack } from "@/butler-ds";

interface VaultPasswordFieldsProps {
  variant: "settings" | "card";
  password: string;
  onPasswordChange: (value: string) => void;
  confirmation?: string;
  onConfirmationChange?: (value: string) => void;
  label?: string;
  hint?: string;
  error: string;
  /** The error is about the confirmation entry (the two entries differ). */
  errorOnConfirmation?: boolean;
  disabled: boolean;
  autoFocus?: boolean;
  onSubmit: () => void;
}

/** The master-password entries: a Settings row each, or stacked fields in the setup card and dialog. */
export function VaultPasswordFields({ variant, password, onPasswordChange, confirmation,
  onConfirmationChange, label = appCopy.butlerVault.masterPassword, hint, error, errorOnConfirmation,
  disabled, autoFocus, onSubmit }: VaultPasswordFieldsProps) {
  const id = useId();
  const confirming = confirmation !== undefined;
  const fields = [
    { label, value: password, change: onPasswordChange, hint, autoFocus,
      error: error && !(confirming && errorOnConfirmation) ? error : "" },
    ...(confirming ? [{ label: appCopy.butlerVault.confirmPassword, value: confirmation, change: onConfirmationChange,
      hint: undefined, autoFocus: false, error: error && errorOnConfirmation ? error : "" }] : []),
  ];
  const rendered = fields.map((field, index) => {
    const fieldId = `${id}-${index}`;
    const input = <Input id={fieldId} type="password" value={field.value} disabled={disabled}
      autoComplete={confirming ? "new-password" : "current-password"} autoFocus={field.autoFocus}
      onChange={(event) => field.change?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!disabled) onSubmit();
        }
      }} />;
    return variant === "settings"
      ? <SettingsField key={fieldId} id={fieldId} label={field.label} description={field.hint}
        error={field.error || undefined} control={input} controlWidth="full" />
      : <Field key={fieldId} data-invalid={field.error ? true : undefined}>
        <FieldLabel htmlFor={fieldId}>{field.label}</FieldLabel>
        {input}
        {field.hint && <FieldDescription>{field.hint}</FieldDescription>}
        {field.error && <FieldError errors={[{ message: field.error }]} />}
      </Field>;
  });
  // Settings rows take their spacing from the section; the card and dialog stack their own fields.
  return variant === "settings" ? <>{rendered}</> : <Stack gap="md">{rendered}</Stack>;
}
