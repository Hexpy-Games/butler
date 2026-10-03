import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import { DecisionGuidePage } from "./pages/DecisionGuidePage";
import { ComposerDecorationPage } from "./pages/ComposerDecorationPage";
import { FoundationChapterPage } from "./pages/FoundationChapterPage";
import { FoundationsPage } from "./pages/FoundationsPage";
import { GalleryPage } from "./pages/GalleryPage";
import { IconsPage } from "./pages/IconsPage";
import { ItemPage } from "./pages/ItemPage";
import { MotionPage } from "./pages/MotionPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PatternPage, PatternsPage } from "./pages/PatternsPage";
import { RecipesPage } from "./pages/RecipesPage";
import type { ResolvedTheme } from "./useViewerTheme";
import type { ViewerPage } from "./viewerNavigation";
import type { ViewerState } from "./viewerState";

export function ViewerContent({ page, anchor, entries, state, themes, onOpen, onChange }: {
  page: ViewerPage;
  /** In-page anchor of the latest navigation (token deep links open the token table). */
  anchor?: string;
  entries: ShowcaseEntry[];
  state: ViewerState;
  themes: ResolvedTheme[];
  onOpen: (page: string) => void;
  onChange: (patch: Partial<ViewerState>) => void;
}) {
  const locale = state.locale === "ko" ? "ko-KR" : "en-US";
  switch (page.kind) {
    case "overview":
      return <OverviewPage entries={entries} onChange={onChange} onOpen={onOpen} state={state} themes={themes} />;
    case "guide":
      return <DecisionGuidePage entries={entries} onOpen={onOpen} />;
    case "recipes":
      return <RecipesPage locale={locale} />;
    case "foundations":
      return <FoundationsPage onOpen={onOpen} />;
    case "foundation":
      return <FoundationChapterPage anchor={anchor} chapter={page.chapter} locale={state.locale} onOpen={onOpen} />;
    case "motion":
      return <MotionPage anchor={anchor} entries={entries} locale={locale} onChange={onChange} onOpen={onOpen} state={state} />;
    case "gallery":
      return <GalleryPage entries={entries} locale={state.locale} onOpen={onOpen} section={page.section} />;
    case "patterns":
      return <PatternsPage locale={locale} onOpen={onOpen} />;
    case "pattern":
      if (page.id === "composer-decorations") return <ComposerDecorationPage state={state} themes={themes} onChange={onChange} />;
      return <PatternPage entries={entries} id={page.id} locale={locale} onOpen={onOpen} />;
    case "item":
      return <ItemPage entries={entries} entry={page.entry} key={page.entry.id} onOpen={onOpen} state={state} themes={themes} />;
    case "icons":
      return <IconsPage locale={state.locale} />;
    case "not-found":
      return <NotFoundPage id={page.id} onOpen={onOpen} />;
  }
}
