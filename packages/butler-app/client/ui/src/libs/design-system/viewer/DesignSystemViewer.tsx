import { useCallback, useEffect, useRef, useState } from "react";
import { showcaseEntries } from "../showcase/loader";
import { DS_VIEWER_BUNDLE_MARKER } from "./bundleMarker";
import { useViewerTheme } from "./useViewerTheme";
import { useViewerUrlState } from "./useViewerUrlState";
import { ViewerContent } from "./ViewerContent";
import { VIEWER_SEARCH_ID, ViewerSidebar } from "./ViewerSidebar";
import { ViewerToolbar } from "./ViewerToolbar";
import { resolveViewerPage } from "./viewerNavigation";
import styles from "./DesignSystemViewer.module.css";

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Focuses search on "/" or Cmd/Ctrl+K while the viewer is open. */
function useSearchShortcut(onFocus: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const slash = event.key === "/" && !isEditable(event.target);
      const commandK = event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
      if (!slash && !commandK) return;
      event.preventDefault();
      onFocus();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onFocus]);
}

export function DesignSystemViewer() {
  const [state, update] = useViewerUrlState();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const theme = useViewerTheme(state.theme);
  const page = resolveViewerPage(state.page, showcaseEntries);
  const activeId = page.kind === "item" ? page.entry.id : state.page;

  const focusSearch = useCallback(() => {
    setMenuOpen(true);
    requestAnimationFrame(() => document.getElementById(VIEWER_SEARCH_ID)?.focus());
  }, []);
  useSearchShortcut(focusSearch);

  const open = useCallback((pageId: string) => {
    update({ page: pageId });
    setMenuOpen(false);
    mainRef.current?.scrollTo({ top: 0 });
  }, [update]);

  return (
    <div
      className={`${styles.viewer} theme-${theme.chrome} sidebar-translucent`}
      data-ds-page={state.page}
      data-ds-viewer={DS_VIEWER_BUNDLE_MARKER}
      data-menu-open={menuOpen}
    >
      <nav aria-label="Design system" className={styles.sidebar}>
        <ViewerSidebar entries={showcaseEntries} onOpen={open} onQueryChange={setQuery} page={activeId} query={query} />
      </nav>
      <main className={styles.main} ref={mainRef}>
        <div className={styles.toolbar}>
          <ViewerToolbar state={state} onChange={update} onToggleMenu={() => setMenuOpen((value) => !value)} />
        </div>
        <div className={styles.content}>
          <ViewerContent entries={showcaseEntries} onOpen={open} page={page} state={state} themes={theme.frames} />
        </div>
      </main>
    </div>
  );
}
