import type { ReactNode } from "react";
import styles from "./TabPanel.module.css";

export interface TabPanelProps {
  /** Matches a Tabs item value. */
  value: string;
  children: ReactNode;
}

export function TabPanel({ value, children }: TabPanelProps) {
  return (
    <div className={styles.panel} data-slot="tabs-panel" data-value={value} role="tabpanel" tabIndex={0}>
      {children}
    </div>
  );
}
