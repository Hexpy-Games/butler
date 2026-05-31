import type { HTMLAttributes, ReactNode } from "react";
import { NavRow } from "@/butler-ds";

interface SidebarItemProps {
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  right?: ReactNode;
  active?: boolean;
  rightVisibility?: "visible" | "hover";
  className?: string;
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
  className,
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
      className={className}
      dataTestClass={dataTestClass}
      onClick={onClick}
      onContextMenu={onContextMenu}
      ariaLabel={ariaLabel}
    />
  );
}
