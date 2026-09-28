import { useAppLocale } from "@/app/copy.ts";
import { useId, useState } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Inline,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SelectButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils.ts";
import { AccessModeOptions } from "@/components/conversation/AccessModeOptions";
import { accessLabel, accessModeIcon } from "@/components/conversation/accessModeUtils";
import { useAutomationStore } from "@/stores/automationStore";

/** The access a schedule's runs get, chosen from the composer's access modes. */
export function AutomationAccessField() {
  useAppLocale();
  const [open, setOpen] = useState(false);
  const controlId = useId();
  const hintId = useId();
  const errorId = useId();
  const accessMode = useAutomationStore((state) => state.accessMode);
  const setAccessMode = useAutomationStore((state) => state.setAccessMode);
  const error = useAutomationStore((state) =>
    state.saveError?.field === "accessMode" ? state.saveError.message : undefined,
  );
  const settings = useButlerStore((state) => state.settings);
  const showHint = accessMode === "ask_first";
  const describedBy = [showHint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ");

  return (
    <Field data-test-class="automation-access-field">
      <FieldLabel htmlFor={controlId}>{appCopy.composer.permission}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SelectButton
            id={controlId}
            aria-describedby={describedBy || undefined}
            aria-invalid={error ? true : undefined}
            data-test-class="automation-access-trigger"
          >
            <Inline gap="xs" wrap={false}>
              {accessModeIcon(accessMode, "sm")}
              {accessLabel(accessMode)}
            </Inline>
          </SelectButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          theme={appShellTheme(settings)}
          data-menu-size="compact"
          sideOffset={6}
        >
          <AccessModeOptions
            value={accessMode}
            onSelect={(mode) => {
              setAccessMode(mode);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {showHint ? <FieldDescription id={hintId}>{appCopy.automations.accessHint}</FieldDescription> : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
