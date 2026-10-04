import { useAppLocale } from "@/app/copy.ts";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, Stack, Typo, Tooltip, OptionMenu, OptionMenuItem } from "@/butler-ds";
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
  menu = false,
}: {
  value: AccessMode;
  menu?: boolean;
  onSelect: (mode: AccessMode) => void;
}) {
  useAppLocale();
  if (menu) return <DropdownMenuRadioGroup data-test-class="composer-menu" value={value} onValueChange={item => onSelect(item as AccessMode)}>
    {ACCESS_MODES.map(item => <Tooltip key={item} wrap label={accessDescription(item)}>
      <DropdownMenuRadioItem value={item}>
        <Stack align="row" cross="center" gap="sm">
          {accessModeIcon(item)}<Typo.Label as="span">{accessLabel(item)}</Typo.Label>
        </Stack>
      </DropdownMenuRadioItem>
    </Tooltip>)}
  </DropdownMenuRadioGroup>;
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
