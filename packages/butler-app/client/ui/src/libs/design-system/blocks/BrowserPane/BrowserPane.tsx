import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./BrowserPane.module.css";

export interface BrowserPaneProps extends Omit<DsBaseProps<HTMLAttributes<HTMLElement>>, "children"> {
  /**
   * `conversation`: beside the chat column (AdaptiveShellSplit pane), off the chat and the window edge.
   * `standalone`: the Browser view under its own title bar, off the window edge.
   */
  placement?: "conversation" | "standalone";
  /** The tab row: a TabStrip (with its `trailing` controls). */
  tabs: ReactNode;
  /** The toolbar row: a BrowserToolbar. */
  toolbar: ReactNode;
  /** The page: a PageCard. */
  children: ReactNode;
  /** Accessible name of the region ("Browser"). */
  label: string;
}

/**
 * The browser sheet: a tinted pane whose top corners match the page card, holding the tab row, the
 * toolbar and the page card inset from its edges. Pure layout; the App owns tabs, navigation and pages.
 */
export function BrowserPane({ placement = "conversation", tabs, toolbar, children, label, className, ...props }: BrowserPaneProps) {
  return (
    <section {...props} className={cn(styles.pane, className)} data-slot="browser-pane" data-placement={placement} aria-label={label}>
      <div className={styles.tabRow} data-slot="browser-pane-tabs">{tabs}</div>
      {toolbar}
      <div className={styles.stage} data-slot="browser-pane-stage">{children}</div>
    </section>
  );
}

export interface BrowserToolbarProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** Back, forward, reload/stop: IconButtons in a `ButtonContainer size="icon-sm"`. */
  navigation: ReactNode;
  /** The AddressField; it takes the remaining width. */
  address: ReactNode;
  /** Page actions (pick, scrap, bookmarks, downloads, more) in one `ButtonContainer size="icon-sm"`. */
  actions?: ReactNode;
}

/** The toolbar row: navigation · address · page actions, aligned to the page card's edges. */
export function BrowserToolbar({ navigation, address, actions, className, ...props }: BrowserToolbarProps) {
  return (
    <div {...props} className={cn(styles.toolbar, className)} role="toolbar" data-slot="browser-toolbar">
      <div className={styles.group}>{navigation}</div>
      <div className={styles.address}>{address}</div>
      {actions ? <div className={styles.group}>{actions}</div> : null}
    </div>
  );
}
