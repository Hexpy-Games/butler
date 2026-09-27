import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "../components/Toast";
import { useHotkey } from "../lib/useHotkey";
import { showcaseEntries } from "../showcase/loader";
import { DS_VIEWER_BUNDLE_MARKER } from "./bundleMarker";
import { PATTERN_IDS } from "./patterns";
import { useViewerTheme } from "./useViewerTheme";
import { useViewerUrlState } from "./useViewerUrlState";
import { ViewerCommandPalette } from "./ViewerCommandPalette";
import { ViewerContent } from "./ViewerContent";
import { VIEWER_SEARCH_ID, ViewerSidebar } from "./ViewerSidebar";
import { ViewerToolbar } from "./ViewerToolbar";
import { resolveViewerPage } from "./viewerNavigation";
import styles from "./DesignSystemViewer.module.css";

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Scrolls `main` so the anchor sits just below the sticky toolbar (its first child). */
function scrollToAnchor(main: HTMLElement | null, id: string | undefined): boolean {
  const target = id ? document.getElementById(id) : null;
  if (!main || !target) return false;
  const toolbar = main.firstElementChild instanceof HTMLElement ? main.firstElementChild.offsetHeight : 0;
  main.scrollTop += target.getBoundingClientRect().top - main.getBoundingClientRect().top - toolbar;
  return true;
}

/** "/" (outside fields) focuses the sidebar filter. */
function useSlashFocus(onFocus: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.isComposing || isEditable(event.target)) return;
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  useHotkey("mod+k", () => setPaletteOpen((value) => !value));
  const mainRef = useRef<HTMLElement>(null);
  const theme = useViewerTheme(state.theme, state.motion);
  // A deep link may carry an in-page anchor: page=components/Button#states.
  const [pageId = "overview", initialAnchor] = state.page.split("#");
  const page = resolveViewerPage(pageId, showcaseEntries, PATTERN_IDS);
  const activeId = page.kind === "item" ? page.entry.id : pageId;
  useEffect(() => {
    if (!initialAnchor) return undefined;
    const timer = window.setTimeout(() => scrollToAnchor(mainRef.current, initialAnchor), 120);
    return () => window.clearTimeout(timer);
    // Only the anchor from the initial URL.
  }, []);

  const focusSearch = useCallback(() => {
    setMenuOpen(true);
    requestAnimationFrame(() => document.getElementById(VIEWER_SEARCH_ID)?.focus());
  }, []);
  useSlashFocus(focusSearch);

  const open = useCallback((target: string) => {
    const [id, anchor] = target.split("#");
    update({ page: id });
    setMenuOpen(false);
    requestAnimationFrame(() => {
      if (!scrollToAnchor(mainRef.current, anchor)) mainRef.current?.scrollTo({ top: 0 });
    });
  }, [update]);

  return (
    <div
      className={`${styles.viewer} theme-${theme.chrome} sidebar-translucent`}
      data-ds-page={pageId}
      data-ds-viewer={DS_VIEWER_BUNDLE_MARKER}
      data-menu-open={menuOpen}
      data-motion={state.motion}
    >
      <nav aria-label="Design system" className={styles.sidebar}>
        <ViewerSidebar entries={showcaseEntries} onOpen={open} onQueryChange={setQuery} page={activeId} query={query} />
      </nav>
      <main className={styles.main} ref={mainRef}>
        <div className={styles.toolbar}>
          <ViewerToolbar page={page} state={state} onChange={update} onOpen={open} onSearch={() => setPaletteOpen(true)}
            onToggleMenu={() => setMenuOpen((value) => !value)} />
        </div>
        <div className={styles.content}>
          <div className={styles.page} key={pageId}>
            <ViewerContent entries={showcaseEntries} onChange={update} onOpen={open} page={page} state={state} themes={theme.frames} />
          </div>
        </div>
      </main>
      {/* One toast region for every page (the app mounts AppToaster the same way); stories only call toast.*. */}
      <Toaster />
      <ViewerCommandPalette entries={showcaseEntries} open={paletteOpen} onClose={() => setPaletteOpen(false)} onOpen={open} onChange={update} />
    </div>
  );
}
