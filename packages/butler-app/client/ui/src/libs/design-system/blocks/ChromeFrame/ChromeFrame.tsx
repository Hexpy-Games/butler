import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./ChromeFrame.module.css";

export interface ChromeFrameProps {
  sidebar?: ReactNode;
  titlebar?: ReactNode;
  inspector?: ReactNode;
  children: ReactNode;
  leftCollapsed?: boolean;
  rightOpen?: boolean;
  className?: string;
}

export interface ChromeFloatingToggleLayerProps {
  children: ReactNode;
}

export function ChromeFrame({
  sidebar,
  titlebar,
  inspector,
  children,
  leftCollapsed = false,
  rightOpen = false,
  className,
}: ChromeFrameProps) {
  return (
    <div
      className={cn(
        styles.frame,
        leftCollapsed && styles.leftCollapsed,
        rightOpen && styles.rightOpen,
        className,
      )}
    >
      {titlebar ? (
        <div className={styles.titlebar} data-slot="chrome-frame-titlebar">
          {titlebar}
        </div>
      ) : null}
      {sidebar ? (
        <aside className={styles.sidebar} data-slot="chrome-frame-sidebar">
          {sidebar}
        </aside>
      ) : null}
      <main className={styles.main} data-slot="chrome-frame-main">
        {children}
      </main>
      {rightOpen && inspector ? (
        <aside className={styles.inspector} data-slot="chrome-frame-inspector">
          {inspector}
        </aside>
      ) : null}
    </div>
  );
}

export function ChromeFloatingToggleLayer({
  children,
}: ChromeFloatingToggleLayerProps) {
  return (
    <div
      className={styles.floatingLayer}
      data-test-class="chrome-floating-toggle-layer"
    >
      <div className={styles.floatingToggle}>{children}</div>
    </div>
  );
}
