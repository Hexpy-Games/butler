import { useAppLocale } from "@/app/copy.ts";
import { OptionMenu, OptionMenuItem } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";
import {
  ACCESS_MODES,
  accessDescription,
  accessLabel,
  accessModeIcon,
  accessModeTone,
  accessPermissionTone,
} from "./accessModeUtils";

/**
 * The access-mode choices with their labels, descriptions and icons. The
 * composer's access menu and the schedule form share it, so both read the same.
 */
export function AccessModeOptions({
  value,
  onSelect,
}: {
  value: AccessMode;
  onSelect: (mode: AccessMode) => void;
}) {
  useAppLocale();
  return (
    <OptionMenu title={appCopy.composer.permission}>
      {ACCESS_MODES.map((item) => (
        <OptionMenuItem
          description={accessDescription(item)}
          descriptionPlacement="block"
          icon={accessModeIcon(item)}
          key={item}
          label={accessLabel(item)}
          selected={item === value}
          permissionTone={accessPermissionTone(item)}
          tone={accessModeTone(item)}
          onClick={() => onSelect(item)}
        />
      ))}
    </OptionMenu>
  );
}
