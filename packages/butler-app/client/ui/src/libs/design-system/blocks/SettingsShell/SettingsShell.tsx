import { useState, type ReactNode } from "react";
import { PageContainer } from "../../components/PageContainer";
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
  /** Changes when the page changes; the header and content re-enter with the page transition. */
  pageKey?: string;
  /** The page's position in the navigation: a larger order enters from below, a smaller from above. */
  pageOrder?: number;
}

type PageDirection = "none" | "forward" | "backward";

/** The direction of the latest page change; the first page does not animate. */
function usePageDirection(pageKey: string | undefined, pageOrder: number | undefined): PageDirection {
  const [page, setPage] = useState({ key: pageKey, order: pageOrder, direction: "none" as PageDirection });
  if (page.key !== pageKey) {
    const direction: PageDirection =
      pageOrder === undefined || page.order === undefined || pageOrder === page.order
        ? "none"
        : pageOrder > page.order ? "forward" : "backward";
    setPage({ key: pageKey, order: pageOrder, direction });
    return direction;
  }
  return page.direction;
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
  pageKey,
  pageOrder,
}: SettingsShellProps) {
  const direction = usePageDirection(pageKey, pageOrder);
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
          <PageContainer key={pageKey} width="narrow" align="start" gutter="none" className={styles.detailHeader} data-page-motion={direction}>
            {detailNavigation ? (
              <div className={styles.detailNavigation}>{detailNavigation}</div>
            ) : null}
            {detailHeader}
          </PageContainer>
        ) : null}
        <ScrollArea
          className={styles.detailScroll}
          dataTestClass="settings-detail-scroll"
        >
          <PageContainer key={pageKey} width="narrow" align="start" gutter="none" className={styles.detailContent} data-page-motion={direction}>
            <SettingsPageProvider title={pageTitle} description={pageDescription}>
              {detail}
            </SettingsPageProvider>
          </PageContainer>
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
