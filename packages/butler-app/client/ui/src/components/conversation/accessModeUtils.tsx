import type { ReactElement } from "react";
import { ShieldCheck, ShieldQuestion, Eye, type IconSize, type PermissionTone } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";

/** Every access mode, in the order the access menus list them. */
export const ACCESS_MODES = ["full_access", "ask_first", "read_only"] as const satisfies readonly AccessMode[];

export function isAccessMode(value: unknown): value is AccessMode {
  return (ACCESS_MODES as readonly unknown[]).includes(value);
}

/** The DS permission tone (label and icon colors) of an access mode. */
export function accessPermissionTone(mode: AccessMode): PermissionTone {
  if (mode === "full_access") return "full";
  if (mode === "ask_first") return "ask";
  return "read";
}

export function accessModeTone(
  mode: AccessMode,
): "warning" | "accent" | "default" {
  if (mode === "full_access") return "warning";
  if (mode === "ask_first") return "accent";
  return "default";
}

export function accessModeIcon(mode: AccessMode, size: IconSize = "md"): ReactElement {
  if (mode === "full_access") return <ShieldCheck size={size} />;
  if (mode === "ask_first") return <ShieldQuestion size={size} />;
  return <Eye size={size} />;
}

export function accessLabel(mode: AccessMode): string {
  if (mode === "full_access") return appCopy.permissions.fullAccess;
  if (mode === "ask_first") return appCopy.permissions.askFirst;
  return appCopy.permissions.readOnly;
}

export function accessDescription(mode: AccessMode): string {
  if (mode === "full_access") return appCopy.permissions.fullAccessDesc;
  if (mode === "ask_first") return appCopy.permissions.askFirstDesc;
  return appCopy.permissions.readOnlyDesc;
}
