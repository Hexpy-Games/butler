import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import styles from "./Tabs.module.css";

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  /** Tab triggers in order; each value matches one TabPanel. The first is selected. */
  items: TabItem[];
  /** Accessible name of the tab list. */
  label: string;
  variant?: "default" | "line";
  /** TabPanel elements. */
  children: ReactNode;
}

/**
 * Server-rendered tabs. The markup is complete without JS (first panel
 * shown); tabs.client.ts adds selection, roving focus and ARIA wiring.
 */
export function Tabs({ items, label, variant = "default", children }: TabsProps) {
  return (
    <div className={styles.root} data-slot="tabs">
      <div
        aria-label={label}
        className={cn(styles.list, styles[`variant-${variant}`])}
        data-scroll-fade="x"
        role="tablist"
      >
        {items.map((item, index) => (
          <button
            aria-selected={index === 0}
            className={styles.trigger}
            data-value={item.value}
            key={item.value}
            role="tab"
            tabIndex={index === 0 ? 0 : -1}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
