import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { Stack } from "../../components/Stack";
import { ScrollArea } from "../ScrollArea";
import { SurfacePanel } from "../SurfacePanel";
import styles from "./SplitBrowser.module.css";

export interface SplitBrowserProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** The category list (NavRows) in the start pane. */
  nav: ReactNode;
  /** The items of the selected category in the end pane. */
  children: ReactNode;
}

/**
 * A two-pane browser inside one surface: categories on the start side, the
 * selected category's items on the end side; both panes scroll at
 * `--split-browser-height`.
 */
export function SplitBrowser({ nav, children, className, ...props }: SplitBrowserProps) {
  return (
    <SurfacePanel elevation="none" className={dsClass(styles.browser, className)} data-slot="split-browser" {...props}>
      <div className={styles.navPane}>
        <ScrollArea className={dsClass(styles.scroller)}>
          <Stack gap="xs">{nav}</Stack>
        </ScrollArea>
      </div>
      <div className={styles.contentPane}>
        <ScrollArea className={dsClass(styles.scroller)}>
          <Stack gap="sm">{children}</Stack>
        </ScrollArea>
      </div>
    </SurfacePanel>
  );
}
