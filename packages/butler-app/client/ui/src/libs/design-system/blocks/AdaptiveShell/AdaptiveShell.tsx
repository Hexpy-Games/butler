import type { HTMLAttributes, ReactNode, Ref } from "react";
import { useRef } from "react";
import { useComposedRefs } from "../../lib/composeRefs";
import { cn } from "../../lib/utils";
import { useAdaptiveDrawer } from "../../responsive";
import styles from "./AdaptiveShell.module.css";
import { useSidebarTrackMotion } from "./useSidebarTrackMotion";

export interface AdaptiveShellProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
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
  ref,
  ...props
}: AdaptiveShellProps) {
  const drawer = useAdaptiveDrawer(chromeEnvironment);
  const rootRef = useRef<HTMLDivElement>(null);
  const composedRef = useComposedRefs(rootRef, ref);
  const { leftTrack, switching } = useSidebarTrackMotion({
    rootRef,
    leftOpen,
    animate: !drawer && !resizing && !settingsActive,
  });
  return (
    <div
      ref={composedRef}
      className={cn(styles.root, className)}
      data-left-open={leftOpen}
      data-left-track={leftTrack}
      data-track-switching={switching || undefined}
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
    <div
      className={cn(styles.sidebar, className)}
      data-open={open}
      data-slot="adaptive-shell-sidebar"
      {...props}
    >
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
    <main
      className={cn(styles.workspace, className)}
      data-slot="adaptive-shell-workspace"
      {...props}
    >
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
