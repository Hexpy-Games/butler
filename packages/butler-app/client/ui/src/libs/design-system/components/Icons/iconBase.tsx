import { HugeiconsIcon } from "@hugeicons/react";
import type { HugeiconsIconProps, IconSvgElement } from "@hugeicons/react";
import type { DsBaseProps } from "../../lib/dsProps";

/** Icon size scale; mirrors --icon-size-sm/md/lg in tokens.css. */
export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, "2xl": 32, "3xl": 48 } as const;
export type IconSize = keyof typeof ICON_SIZE;

// Icon component props extending Hugeicons with simplified API
export interface IconProps extends Omit<DsBaseProps<HugeiconsIconProps>, "icon" | "size"> {
  size?: IconSize | number;
}

/** One DS glyph: a Hugeicons element (or a DS-drawn one on the same 24px stroke grid) at the DS size scale. */
export function createIcon(icon: IconSvgElement) {
  return ({ size = "md", ...props }: IconProps) => (
    <HugeiconsIcon
      icon={icon}
      size={typeof size === "string" ? ICON_SIZE[size] : size}
      {...props}
    />
  );
}
