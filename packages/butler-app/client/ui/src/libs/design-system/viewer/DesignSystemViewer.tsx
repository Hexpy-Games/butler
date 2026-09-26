import { useCallback, useEffect, useRef, useState } from "react";
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
  const page = resolveViewerPage(state.page, showcaseEntries, PATTERN_IDS);
  const activeId = page.kind === "item" ? page.entry.id : state.page;

  const focusSearch = useCallback(() => {
    setMenuOpen(true);
    requestAnimationFrame(() => document.getElementById(VIEWER_SEARCH_ID)?.focus());
  }, []);
  useSlashFocus(focusSearch);

  const open = useCallback((pageId: string) => {
    const [id, anchor] = pageId.split("#");
    update({ page: id });
    setMenuOpen(false);
    requestAnimationFrame(() => {
      const target = anchor ? document.getElementById(anchor) : null;
      if (target) target.scrollIntoView({ block: "start" });
      else mainRef.current?.scrollTo({ top: 0 });
    });
  }, [update]);

  return (
    <div
      className={`${styles.viewer} theme-${theme.chrome} sidebar-translucent`}
      data-ds-page={state.page}
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
          <div className={styles.page} key={state.page}>
            <ViewerContent entries={showcaseEntries} onChange={update} onOpen={open} page={page} state={state} themes={theme.frames} />
          </div>
        </div>
      </main>
      <ViewerCommandPalette entries={showcaseEntries} open={paletteOpen} onClose={() => setPaletteOpen(false)} onOpen={open} onChange={update} />
    </div>
  );
}
