import type { ReactNode } from "react";
import { ScrollArea } from "../ScrollArea";
import styles from "./SettingsShell.module.css";
import { SettingsPageProvider } from "./settingsPage";

export interface SettingsShellProps {
  sidebar: ReactNode;
  detailHeader?: ReactNode;
  detail: ReactNode;
  active?: boolean;
  compactPane?: "master" | "detail";
  detailNavigation?: ReactNode;
  /** Title the detail header shows; sections never repeat it (see FormSection). */
  pageTitle?: string;
  /** Description the detail header shows; section descriptions never repeat it. */
  pageDescription?: string;
}

export function SettingsShell({
  sidebar,
  detailHeader,
  detail,
  active = false,
  compactPane = "master",
  detailNavigation,
  pageTitle,
  pageDescription,
}: SettingsShellProps) {
  return (
    <section
      className={[styles.shell, active && styles.active]
        .filter(Boolean)
        .join(" ")}
      data-test-class={`settings-view${active ? " settings-view-active" : ""}`}
      data-compact-pane={compactPane}
    >
      <aside
        className={[styles.sidebar, active && styles.sidebarActive]
          .filter(Boolean)
          .join(" ")}
        data-test-class="settings-sidebar"
      >
        {sidebar}
      </aside>
      <main
        className={[
          styles.detail,
          active && styles.detailActive,
          "settings-detail",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {detailHeader ? (
          <div className={styles.detailHeader}>
            {detailNavigation ? (
              <div className={styles.detailNavigation}>{detailNavigation}</div>
            ) : null}
            {detailHeader}
          </div>
        ) : null}
        <ScrollArea
          className={styles.detailScroll}
          contentClassName={styles.detailContent}
          dataTestClass="settings-detail-scroll"
        >
          <SettingsPageProvider title={pageTitle} description={pageDescription}>
            {detail}
          </SettingsPageProvider>
        </ScrollArea>
      </main>
      {active ? (
        <div
          aria-hidden="true"
          className={styles.titlebarDragOverlay}
          data-test-class="settings-titlebar-drag-overlay settings-detail-drag-lane"
        />
      ) : null}
    </section>
  );
}
