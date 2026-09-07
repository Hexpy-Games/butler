import type {
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { useAdaptiveDrawer } from "../../responsive";
import styles from "./AdaptiveShell.module.css";

export interface AdaptiveShellProps extends HTMLAttributes<HTMLDivElement> {
  leftOpen: boolean;
  rightOpen: boolean;
  settingsActive?: boolean;
  resizing?: boolean;
  transparentWorkspace?: boolean;
  chromeEnvironment?: "browser" | "electron";
  platform?: "browser" | "darwin" | "linux" | "win32";
  compactSidebarFullWidth?: boolean;
}
export function AdaptiveShell({
  leftOpen,
  rightOpen,
  settingsActive = false,
  resizing = false,
  transparentWorkspace = false,
  chromeEnvironment = "browser",
  platform = "browser",
  compactSidebarFullWidth = false,
  className,
  children,
  ...props
}: AdaptiveShellProps) {
  const drawer = useAdaptiveDrawer(chromeEnvironment);
  return (
    <div
      className={cn(styles.root, className)}
      data-left-open={leftOpen}
      data-right-open={rightOpen}
      data-settings-active={settingsActive}
      data-resizing={resizing}
      data-transparent-workspace={transparentWorkspace}
      data-chrome-environment={chromeEnvironment}
      data-panel-layout={drawer ? "drawer" : "docked"}
      data-platform={platform}
      data-compact-sidebar-full-width={compactSidebarFullWidth || undefined}
      {...props}
    >
      {children}
    </div>
  );
}

export function AdaptiveShellSidebar({
  children,
  className,
  open,
  ...props
}: HTMLAttributes<HTMLDivElement> & { open: boolean }) {
  return (
    <div className={cn(styles.sidebar, className)} data-open={open} {...props}>
      {children}
    </div>
  );
}

export function AdaptiveShellWorkspace({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <main className={cn(styles.workspace, className)} {...props}>
      {children}
    </main>
  );
}

export function AdaptiveShellInspector({
  children,
  className,
  open,
  ...props
}: HTMLAttributes<HTMLDivElement> & { open: boolean }) {
  return (
    <div className={cn(styles.inspector, className)} data-open={open} {...props}>
      {children}
    </div>
  );
}

export function AdaptiveShellChrome({ children }: { children: ReactNode }) {
  return <div className={styles.chrome}>{children}</div>;
}
export function AdaptivePanelResizeHandle({
  side,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "onKeyDown" | "onPointerDown"> & {
  side: "left" | "right";
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={styles.resizeHandle}
      data-side={side}
      role="separator"
      tabIndex={0}
      {...props}
    />
  );
}

export function AdaptiveShellScrim({
  open,
  onDismiss,
  label,
}: {
  open: boolean;
  onDismiss: () => void;
  label: string;
}) {
  return (
    <button
      aria-hidden={!open}
      aria-label={label}
      className={styles.scrim}
      data-open={open}
      data-slot="adaptive-shell-scrim"
      onClick={onDismiss}
      tabIndex={open ? 0 : -1}
      type="button"
    />
  );
}

export function AdaptivePanelTitlebar({
  children,
  open,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { open: boolean }) {
  return (
    <div
      className={cn(styles.panelTitlebar, className)}
      data-open={open}
      {...props}
    >
      {children}
    </div>
  );
}
