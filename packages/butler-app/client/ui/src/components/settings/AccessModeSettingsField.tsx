import { useId, useState } from "react";
import {
  Inline, Popover, PopoverContent, PopoverTrigger, SelectButton, SettingsField,
} from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AccessMode } from "@/app/types.ts";
import { appShellTheme } from "@/app/utils.ts";
import { AccessModeOptions } from "@/components/conversation/AccessModeOptions";
import { accessLabel, accessModeIcon } from "@/components/conversation/accessModeUtils";

/**
 * A Settings field that picks an access mode from the shared access list
 * (icons, descriptions, recommended and default marks), like the composer.
 */
export function AccessModeSettingsField({ settingId, label, description, value, factoryDefault, onChange }: {
  settingId: string;
  label: string;
  description: string;
  value: AccessMode;
  factoryDefault: AccessMode;
  onChange: (mode: AccessMode) => void;
}) {
  useAppLocale();
  const [open, setOpen] = useState(false);
  const controlId = useId();
  const descriptionId = useId();
  const settings = useButlerStore((state) => state.settings);
  return (
    <SettingsField
      settingId={settingId}
      data-test-class="settings-field"
      id={controlId}
      label={label}
      description={description}
      descriptionId={descriptionId}
      control={
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SelectButton id={controlId} aria-describedby={descriptionId} data-test-class="access-mode-trigger">
              <Inline as="span" gap="xs" wrap={false}>
                {accessModeIcon(value, "sm")}
                {accessLabel(value)}
              </Inline>
            </SelectButton>
          </PopoverTrigger>
          <PopoverContent align="start" theme={appShellTheme(settings)} data-menu-size="compact" sideOffset={6}>
            <AccessModeOptions
              value={value}
              factoryDefault={factoryDefault}
              onSelect={(mode) => {
                onChange(mode);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      }
    />
  );
}
