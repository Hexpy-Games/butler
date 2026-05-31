import type { CSSProperties, ReactElement } from "react";
import { ShieldCheck, ShieldQuestion, Eye } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";

export function accessModeStyle(mode: AccessMode): CSSProperties {
  const colorToken = `var(${accessModeColorToken(mode)})`;
  const iconColorToken = `var(${accessModeIconColorToken(mode)})`;
  return {
    "--composer-control-icon-color": iconColorToken,
    "--option-menu-icon-color": iconColorToken,
    color: colorToken,
  } as CSSProperties;
}

export function accessModeColorToken(mode: AccessMode): string {
  if (mode === "full_access") return "--access-full";
  if (mode === "ask_first") return "--access-ask";
  return "--access-read";
}

export function accessModeIconColorToken(mode: AccessMode): string {
  if (mode === "read_only") return "--access-read-icon";
  return accessModeColorToken(mode);
}

export function accessModeTone(
  mode: AccessMode,
): "warning" | "accent" | "default" {
  if (mode === "full_access") return "warning";
  if (mode === "ask_first") return "accent";
  return "default";
}

export function accessModeIcon(mode: AccessMode, size = 15): ReactElement {
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
