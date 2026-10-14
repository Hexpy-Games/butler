import { withUnsafeStyle, type DsBaseProps, type UnsafeStyleProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { useRef } from "react";
import { useComposedRefs } from "../../lib/composeRefs";
import { cn } from "../../lib/utils";
import { useAdaptiveDrawer } from "../../responsive";
import styles from "./AdaptiveShell.module.css";
import frame from "./AdaptiveShellFrame.module.css";
import cards from "./AdaptiveShellCards.module.css";
import { ShellFrameContext, type ShellFrame } from "./shellFrame";
import { adaptiveShellThemeClasses, type AdaptiveShellTheme } from "./theme";
import { useSidebarTrackMotion } from "./useSidebarTrackMotion";
import { useInspectorTrackMotion } from "./useInspectorTrackMotion";

export interface AdaptiveShellProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>>, UnsafeStyleProps {
  /** Applies the theme token classes to the shell root. */
  theme?: AdaptiveShellTheme;
  ref?: Ref<HTMLDivElement>;
  leftOpen: boolean;
  rightOpen: boolean;
  settingsActive?: boolean;
  resizing?: boolean;
  transparentWorkspace?: boolean;
  chromeEnvironment?: "browser" | "electron";
  platform?: "browser" | "darwin" | "linux" | "win32";
  compactSidebarFullWidth?: boolean;
  /**
   * The conversation frame shows the browser pane (AdaptiveShellSplit). The inspector and the pane
   * never show together: while this is true the inspector stays closed whatever `rightOpen` says.
   */
  splitOpen?: boolean;
  /** The collapsed sidebar floats over the workspace as a card (docked layout only; AdaptiveShellPeekEdge). */
  leftPeek?: boolean;
  /**
   * `cards`: the sidebar, window chrome and title row are one shell surface and the content sits in
   * rounded cards (AdaptiveShellCard, the split's chat and pane, the inspector, the settings detail),
   * inset from the window edges. Docked layout only; drawers stay full-bleed. Default `flat`.
   */
  frame?: ShellFrame;
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
  splitOpen = false,
  leftPeek = false,
  frame: shellFrame = "flat",
  theme,
  className,
  style,
  UNSAFE_style,
  children,
  ref,
  ...props
}: AdaptiveShellProps) {
  const drawer = useAdaptiveDrawer(chromeEnvironment);
  const inspectorOpen = rightOpen && !splitOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const composedRef = useComposedRefs(rootRef, ref);
  const { leftTrack, switching } = useSidebarTrackMotion({
    rootRef,
    leftOpen,
    animate: !resizing && !settingsActive,
    drawer,
  });
  const { rightTrack, switching: rightSwitching } = useInspectorTrackMotion({
    rootRef,
    rightOpen: inspectorOpen,
    animate: !drawer && !resizing && !settingsActive,
    frame: shellFrame,
  });
  return (
    <ShellFrameContext.Provider value={shellFrame}>
      <div
        ref={composedRef}
        className={cn(styles.root, cards.root, theme && adaptiveShellThemeClasses(theme), className)}
        data-theme={theme?.appearance}
        data-frame={shellFrame}
        data-left-open={leftOpen}
        data-left-track={leftTrack}
        data-track-switching={switching || rightSwitching || undefined}
        data-right-open={inspectorOpen}
        data-split-open={splitOpen || undefined}
        data-left-peek={leftPeek && !leftOpen ? "true" : undefined}
        data-right-track={rightTrack}
        data-settings-active={settingsActive}
        data-resizing={resizing}
        data-transparent-workspace={transparentWorkspace}
        data-chrome-environment={chromeEnvironment}
        data-panel-layout={drawer ? "drawer" : "docked"}
        data-platform={platform}
        data-compact-sidebar-full-width={compactSidebarFullWidth || undefined}
        style={withUnsafeStyle(style, UNSAFE_style)}
        {...props}
      >
        {children}
      </div>
    </ShellFrameContext.Provider>
  );
}

export function AdaptiveShellSidebar({
  children,
  className,
  open,
  ...props
}: DsBaseProps<HTMLAttributes<HTMLDivElement>> & { open: boolean }) {
  return (
    <div
      className={cn(styles.sidebar, frame.peekable, className)}
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
}: DsBaseProps<HTMLAttributes<HTMLElement>>) {
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
}: DsBaseProps<HTMLAttributes<HTMLDivElement>> & { open: boolean }) {
  return (
    <div className={cn(styles.inspector, className)} data-open={open} data-slot="adaptive-shell-inspector" {...props}>
      {children}
    </div>
  );
}

export function AdaptiveShellChrome({ children }: { children: ReactNode }) {
  return <div className={styles.chrome}>{children}</div>;
}
