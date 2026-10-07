import type { ReactNode } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { Inline, OptionMenu, OptionMenuItem, Tag, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";
import {
  RECOMMENDED_ACCESS_MODE,
  accessDescription,
  accessLabel,
  accessModeChoices,
  accessModeIcon,
  accessPermissionTone,
} from "./accessModeUtils";

/**
 * The access-mode choices with their labels, descriptions and icons. The
 * composer's access menu, the schedule form and the Settings default share it,
 * so all read the same. `factoryDefault` marks a Settings field's own default.
 */
export function AccessModeOptions({
  value,
  onSelect,
  factoryDefault,
}: {
  value: AccessMode;
  onSelect: (mode: AccessMode) => void;
  factoryDefault?: AccessMode;
}) {
  useAppLocale();
  return (
    <OptionMenu title={appCopy.composer.permission}>
      {accessModeChoices(value).map((item) => (
        <OptionMenuItem
          description={accessDescription(item)}
          descriptionPlacement="block"
          icon={accessModeIcon(item)}
          key={item}
          label={optionLabel(item, factoryDefault)}
          selected={item === value}
          permissionTone={accessPermissionTone(item)}
          onClick={() => onSelect(item)}
        />
      ))}
    </OptionMenu>
  );
}

function optionLabel(mode: AccessMode, factoryDefault: AccessMode | undefined): ReactNode {
  const recommended = mode === RECOMMENDED_ACCESS_MODE;
  const isDefault = mode === factoryDefault;
  if (!recommended && !isDefault) return accessLabel(mode);
  return (
    <Inline as="span" gap="xs" wrap={false}>
      {accessLabel(mode)}
      {recommended ? <Tag tone="accent">{appCopy.permissions.recommended}</Tag> : null}
      {isDefault ? <Typo.Caption tone="tertiary">{appCopy.interfaceDetails.default}</Typo.Caption> : null}
    </Inline>
  );
}
