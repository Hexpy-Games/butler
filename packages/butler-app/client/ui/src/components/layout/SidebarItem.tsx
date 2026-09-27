import type { HTMLAttributes, ReactNode } from "react";
import { NavRow } from "@/butler-ds";

interface SidebarItemProps {
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  right?: ReactNode;
  active?: boolean;
  rightVisibility?: "visible" | "hover" | "hover-compact-hidden";
  dataTestClass?: string;
  onClick?: HTMLAttributes<HTMLDivElement>["onClick"];
  onContextMenu?: HTMLAttributes<HTMLDivElement>["onContextMenu"];
  ariaLabel?: string;
}

export function SidebarItem({
  title,
  icon,
  badge,
  right,
  active = false,
  rightVisibility = "visible",
  dataTestClass,
  onClick,
  onContextMenu,
  ariaLabel,
}: SidebarItemProps) {
  return (
    <NavRow
      label={title}
      icon={icon}
      badge={badge}
      actions={right}
      active={active}
      actionsVisibility={rightVisibility}
      dataTestClass={dataTestClass}
      onClick={onClick}
      onContextMenu={onContextMenu}
      ariaLabel={ariaLabel}
    />
  );
}
