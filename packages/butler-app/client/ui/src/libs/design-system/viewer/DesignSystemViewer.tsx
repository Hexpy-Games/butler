import { useCallback, useEffect, useRef, useState } from "react";
import { AdaptiveShell, AdaptiveShellChrome, AdaptiveShellScrim, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "../blocks/AdaptiveShell";
import { ChromeFloatingToggleLayer } from "../blocks/ChromeFrame";
import { IconButton } from "../components/IconButton";
import { PanelLeft, PanelLeftOpen } from "../components/Icons";
import { Toaster } from "../components/Toast";
import { useHotkey } from "../lib/useHotkey";
import { ADAPTIVE_MEDIA, adaptiveDrawerQuery, useAdaptiveDrawer, useMediaMatch } from "../responsive";
import { showcaseEntries } from "../showcase/loader";
import { DS_VIEWER_BUNDLE_MARKER } from "./bundleMarker";
import { PATTERN_IDS } from "./patterns";
import { useNavDrawer } from "./useNavDrawer";
import { useViewerTheme } from "./useViewerTheme";
import { useViewerUrlState } from "./useViewerUrlState";
import { ViewerCommandPalette } from "./ViewerCommandPalette";
import { ViewerContent } from "./ViewerContent";
import { VIEWER_SEARCH_ID, ViewerSidebar } from "./ViewerSidebar";
import { ViewerTitlebar } from "./ViewerToolbar";
import { resolveViewerPage } from "./viewerNavigation";
import styles from "./DesignSystemViewer.module.css";

const NAV_ID = "ds-viewer-nav";

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Scrolls the page so the anchor sits at the top of the scroller, just below the titlebar row. */
function scrollToAnchor(scroller: HTMLElement | null, id: string | undefined): boolean {
  const target = id ? document.getElementById(id) : null;
  if (!scroller || !target) return false;
  scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
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

/** Docked on wide screens; below 1024px a closed drawer, as in the app. */
function useNavOpen(drawer: boolean) {
  const [navOpen, setNavOpen] = useState(() => !window.matchMedia(adaptiveDrawerQuery("browser")).matches);
  const [layout, setLayout] = useState(drawer);
  if (layout !== drawer) {
    setLayout(drawer);
    setNavOpen(!drawer);
  }
  return [navOpen, setNavOpen] as const;
}

export function DesignSystemViewer() {
  const [state, update] = useViewerUrlState();
  const [query, setQuery] = useState("");
  // The app's shell: a docked sidebar on wide screens, a push drawer over a scrim below 1024px.
  const drawer = useAdaptiveDrawer("browser");
  const compact = useMediaMatch(ADAPTIVE_MEDIA.compact);
  const [navOpen, setNavOpen] = useNavOpen(drawer);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useHotkey("mod+k", () => setPaletteOpen((value) => !value));
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const theme = useViewerTheme(state.theme, state.motion);
  // A deep link may carry an in-page anchor: page=components/Button#states.
  const [pageId = "overview", initialAnchor] = state.page.split("#");
  const page = resolveViewerPage(pageId, showcaseEntries, PATTERN_IDS);
  // The anchor of the latest navigation: pages open what it points at (a collapsed token table).
  const [anchor, setAnchor] = useState(initialAnchor);
  const activeId = page.kind === "item" ? page.entry.id : pageId;
  useEffect(() => {
    if (!initialAnchor) return undefined;
    let active = true;
    let frame = requestAnimationFrame(() => {
      void document.fonts.ready.then(() => {
        if (active) frame = requestAnimationFrame(() => scrollToAnchor(scrollRef.current, initialAnchor));
      });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
    // Only the anchor from the initial URL.
  }, []);

  // The open drawer is modal: Escape, scrim and toggle close it; the page behind is inert.
  const modal = drawer && navOpen;
  const closeNav = useCallback(() => setNavOpen(false), [setNavOpen]);
  useNavDrawer({ active: modal, root: shellRef, onClose: closeNav });

  const focusSearch = useCallback(() => {
    setNavOpen(true);
    requestAnimationFrame(() => document.getElementById(VIEWER_SEARCH_ID)?.focus());
  }, [setNavOpen]);
  useSlashFocus(focusSearch);

  const open = useCallback((target: string) => {
    const [id, next] = target.split("#");
    update({ page: id });
    setAnchor(next);
    // Navigating closes the drawer; the docked sidebar stays.
    if (drawer) setNavOpen(false);
    requestAnimationFrame(() => {
      if (!scrollToAnchor(scrollRef.current, next)) scrollRef.current?.scrollTo({ top: 0 });
    });
  }, [update, drawer, setNavOpen]);

  return (
    <AdaptiveShell
      data-ds-page={pageId}
      data-ds-viewer={DS_VIEWER_BUNDLE_MARKER}
      data-menu-open={navOpen}
      data-motion={state.motion}
      leftOpen={navOpen}
      ref={shellRef}
      rightOpen={false}
    >
      <AdaptiveShellSidebar aria-hidden={drawer && !navOpen ? true : undefined} id={NAV_ID} open={navOpen} tabIndex={-1}>
        <ViewerSidebar entries={showcaseEntries} onOpen={open} onQueryChange={setQuery} page={activeId} query={query} />
      </AdaptiveShellSidebar>
      <AdaptiveShellWorkspace inert={modal || undefined}>
        <ViewerTitlebar compact={compact} drawer={drawer} navOpen={navOpen} page={page} state={state}
          onChange={update} onOpen={open} onSearch={() => setPaletteOpen(true)} />
        <div className={styles.scroll} data-ds-scroll ref={scrollRef}>
          <div className={styles.content}>
            <div className={styles.page} key={pageId}>
              <ViewerContent anchor={anchor} entries={showcaseEntries} onChange={update} onOpen={open} page={page} state={state} themes={theme.frames} />
            </div>
          </div>
        </div>
      </AdaptiveShellWorkspace>
      <AdaptiveShellScrim label="Close navigation" open={modal} onDismiss={closeNav} />
      <AdaptiveShellChrome>
        <ChromeFloatingToggleLayer>
          <IconButton aria-controls={NAV_ID} aria-expanded={navOpen} data-ds-nav-toggle
            label={navOpen ? "Close navigation" : "Open navigation"} onClick={() => setNavOpen((value) => !value)}>
            {navOpen ? <PanelLeftOpen size="md" /> : <PanelLeft size="md" />}
          </IconButton>
        </ChromeFloatingToggleLayer>
      </AdaptiveShellChrome>
      {/* One toast region for every page (the app mounts AppToaster the same way); stories only call toast.*. */}
      <Toaster />
      <ViewerCommandPalette entries={showcaseEntries} open={paletteOpen} onClose={() => setPaletteOpen(false)} onOpen={open} onChange={update} />
    </AdaptiveShell>
  );
}
