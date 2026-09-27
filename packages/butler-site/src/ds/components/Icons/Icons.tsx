/**
 * Web icon subset, forked from the app DS Icons (Hugeicons, same glyph mapping).
 * Icons are decorative: the owning control carries the accessible name.
 */
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowUpRight01Icon, Cancel01Icon, CancelCircleIcon,
  CheckmarkCircle02Icon, ComputerIcon, Copy01Icon, GithubIcon, InformationCircleIcon, Moon02Icon, PanelLeftIcon,
  Search01Icon, Sun03Icon, Tick02Icon,
} from "@hugeicons/core-free-icons";

/** Mirrors --icon-size-* in tokens.css. */
export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, "2xl": 32 } as const;
export type IconSize = keyof typeof ICON_SIZE;

export interface IconProps {
  size?: IconSize;
}

function createIcon(icon: IconSvgElement) {
  return function Icon({ size = "md" }: IconProps) {
    return <HugeiconsIcon aria-hidden="true" focusable="false" icon={icon} size={ICON_SIZE[size]} />;
  };
}

export const AlertTriangle = createIcon(Alert02Icon);
export const ArrowLeft = createIcon(ArrowLeft01Icon);
export const ArrowRight = createIcon(ArrowRight01Icon);
export const ArrowUpRight = createIcon(ArrowUpRight01Icon);
export const Check = createIcon(Tick02Icon);
export const CheckCircle = createIcon(CheckmarkCircle02Icon);
export const Close = createIcon(Cancel01Icon);
export const CircleX = createIcon(CancelCircleIcon);
export const Computer = createIcon(ComputerIcon);
export const Copy = createIcon(Copy01Icon);
export const GitHub = createIcon(GithubIcon);
export const Info = createIcon(InformationCircleIcon);
export const Moon = createIcon(Moon02Icon);
export const PanelLeft = createIcon(PanelLeftIcon);
export const Search = createIcon(Search01Icon);
export const Sun = createIcon(Sun03Icon);
