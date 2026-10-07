import type { ReactElement } from "react";
import {
  CheckList, Eye, ShieldCheck, ShieldEnergy, ShieldQuestion,
  type IconSize, type PermissionTone,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";

/**
 * Every access mode in the order the access menus list them: the recommended
 * mode first, then least to most permissive.
 */
export const ACCESS_MODES = [
  "auto", "read_only", "ask_first", "ask_except_reads", "full_access",
] as const satisfies readonly AccessMode[];

/** The mode the menus mark as recommended. */
export const RECOMMENDED_ACCESS_MODE: AccessMode = "auto";

/** A new chat's mode on a fresh install (the Settings field marks it as the default). */
export const CHAT_ACCESS_FACTORY_DEFAULT: AccessMode = "ask_except_reads";

/** Modes the agent does not run yet: hidden from the menus unless already selected. */
const UNSHIPPED_ACCESS_MODES: ReadonlySet<AccessMode> = new Set<AccessMode>(["auto"]);

export function isAccessMode(value: unknown): value is AccessMode {
  return (ACCESS_MODES as readonly unknown[]).includes(value);
}

/** The modes a menu offers: every shipped mode, plus the current one. */
export function accessModeChoices(current: AccessMode): AccessMode[] {
  return ACCESS_MODES.filter((mode) => !UNSHIPPED_ACCESS_MODES.has(mode) || mode === current);
}

interface AccessModeMeta {
  tone: PermissionTone;
  Icon: typeof Eye;
  label: () => string;
  description: () => string;
}

/** Wire value -> look and copy. `ask_first` is Ask every time; `ask_except_reads` is Ask first. */
const ACCESS_MODE_META: Record<AccessMode, AccessModeMeta> = {
  read_only: {
    tone: "read", Icon: Eye,
    label: () => appCopy.permissions.readOnly, description: () => appCopy.permissions.readOnlyDesc,
  },
  ask_first: {
    tone: "ask", Icon: CheckList,
    label: () => appCopy.permissions.askAlways, description: () => appCopy.permissions.askAlwaysDesc,
  },
  ask_except_reads: {
    tone: "ask", Icon: ShieldQuestion,
    label: () => appCopy.permissions.askFirst, description: () => appCopy.permissions.askFirstDesc,
  },
  auto: {
    tone: "ask", Icon: ShieldEnergy,
    label: () => appCopy.permissions.auto, description: () => appCopy.permissions.autoDesc,
  },
  full_access: {
    tone: "full", Icon: ShieldCheck,
    label: () => appCopy.permissions.fullAccess, description: () => appCopy.permissions.fullAccessDesc,
  },
};

/** The DS permission tone (label and icon colors) of an access mode. */
export function accessPermissionTone(mode: AccessMode): PermissionTone {
  return ACCESS_MODE_META[mode].tone;
}

export function accessModeIcon(mode: AccessMode, size: IconSize = "md"): ReactElement {
  const { Icon } = ACCESS_MODE_META[mode];
  return <Icon size={size} />;
}

export function accessLabel(mode: AccessMode): string {
  return ACCESS_MODE_META[mode].label();
}

export function accessDescription(mode: AccessMode): string {
  return ACCESS_MODE_META[mode].description();
}
