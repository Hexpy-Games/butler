import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./InspectorShell.module.css";

export interface InspectorShellTab {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface InspectorShellProps {
  id?: string;
  open?: boolean;
  activeTab: string;
  tabs: InspectorShellTab[];
  onTabChange: (tabId: string) => void;
  children: ReactNode;
  className?: string;
}

export function InspectorShell({
  id,
  open = true,
  activeTab,
  tabs,
  onTabChange,
  children,
  className,
}: InspectorShellProps) {
  return (
    <aside
      className={cn(styles.shell, open ? styles.open : styles.collapsed, className)}
      data-test-class={`right-inspector${open ? " right-inspector-open" : ""}`}
      id={id}
    >
      <div className={styles.tabs}>
        {tabs.map((tab) => (
          <button
            aria-current={activeTab === tab.id ? "page" : undefined}
            className={activeTab === tab.id ? styles.activeTab : undefined}
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className={styles.content}>{children}</div>
    </aside>
  );
}
