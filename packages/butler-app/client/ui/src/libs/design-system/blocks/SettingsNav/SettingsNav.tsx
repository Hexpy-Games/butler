import type { ReactNode } from "react";
import { NavSection } from "../NavSection";
import { NavRow } from "../NavRow";
import styles from "./SettingsNav.module.css";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  badge?: ReactNode;
  onSelect?: () => void;
}

export interface SettingsNavProps {
  title?: string;
  items: SettingsNavItem[];
}

export function SettingsNav({ title = "Settings", items }: SettingsNavProps) {
  return (
    <nav className={styles.nav} aria-label={title}>
      <NavSection title={title}>
        {items.map((item) => (
          <NavRow
            key={item.id}
            icon={item.icon}
            label={item.label}
            badge={item.badge}
            active={item.active}
            onClick={item.onSelect}
          />
        ))}
      </NavSection>
    </nav>
  );
}
