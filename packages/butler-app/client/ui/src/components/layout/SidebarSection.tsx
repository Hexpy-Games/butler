import type { ReactNode } from "react";
import { NavSection } from "@/butler-ds";

interface SidebarSectionProps {
  title: string;
  actions: ReactNode;
  children: ReactNode;
  collapsed?: boolean;
}

export function SidebarSection({
  title,
  actions,
  children,
  collapsed = false,
}: SidebarSectionProps) {
  return (
    <NavSection
      title={title}
      actions={actions}
      collapsed={collapsed}
    >
      {children}
    </NavSection>
  );
}
