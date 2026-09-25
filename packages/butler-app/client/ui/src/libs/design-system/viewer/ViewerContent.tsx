import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import { FoundationsPage } from "./pages/FoundationsPage";
import { GalleryPage } from "./pages/GalleryPage";
import { ItemPage } from "./pages/ItemPage";
import { OverviewPage } from "./pages/OverviewPage";
import { NotFoundPage, PlaceholderPage } from "./pages/PlaceholderPage";
import type { ResolvedTheme } from "./useViewerTheme";
import type { ViewerPage } from "./viewerNavigation";
import type { ViewerState } from "./viewerState";

export function ViewerContent({ page, entries, state, themes, onOpen }: {
  page: ViewerPage;
  entries: ShowcaseEntry[];
  state: ViewerState;
  themes: ResolvedTheme[];
  onOpen: (page: string) => void;
}) {
  switch (page.kind) {
    case "overview":
      return <OverviewPage entries={entries} onOpen={onOpen} />;
    case "foundations":
      return <FoundationsPage />;
    case "gallery":
      return <GalleryPage entries={entries} locale={state.locale} onOpen={onOpen} section={page.section} />;
    case "item":
      return <ItemPage entry={page.entry} key={page.entry.id} state={state} themes={themes} />;
    case "placeholder":
      return <PlaceholderPage section={page.section} />;
    case "not-found":
      return <NotFoundPage id={page.id} onOpen={onOpen} />;
  }
}
