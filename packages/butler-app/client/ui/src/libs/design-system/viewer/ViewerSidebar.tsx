import { useState, type KeyboardEvent, type ReactNode } from "react";
import { CollapsibleNavGroup } from "../blocks/CollapsibleNavGroup";
import { EmptyLine } from "../blocks/EmptyLine";
import { NavRow } from "../blocks/NavRow";
import { NavSection } from "../blocks/NavSection";
import {
  Blocks, BookOpenText, Folder, FolderOpen, ImageIcon, LayoutDashboard, MagicWand, Palette, Sparkles,
} from "../components/Icons";
import { Input } from "../components/Input";
import { Stack } from "../components/Stack";
import { Typo } from "../components/Typo";
import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import { chapterPage, FOUNDATION_CHAPTERS } from "./foundations/chapters";
import { PATTERNS } from "./patterns";
import { filterEntries, groupEntries } from "./viewerNavigation";
import styles from "./DesignSystemViewer.module.css";

export const VIEWER_SEARCH_ID = "ds-viewer-search";

interface ViewerSidebarProps {
  entries: ShowcaseEntry[];
  page: string;
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (page: string) => void;
}

function PageRow({ id, label, page, icon, onOpen }: {
  id: string; label: string; page: string; icon?: ReactNode; onOpen: (page: string) => void;
}) {
  return (
    <div data-ds-nav-item={id}>
      <NavRow density="compact" icon={icon} label={label} active={page === id} onClick={() => onOpen(id)} />
    </div>
  );
}

function EntryGroups({ entries, kind, page, onOpen }: {
  entries: ShowcaseEntry[]; kind: ShowcaseEntry["kind"]; page: string; onOpen: (page: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (category: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(category)) next.add(category);
    return next;
  });
  return groupEntries(entries, kind).map((group) => {
    const expanded = !collapsed.has(group.category);
    return (
      <CollapsibleNavGroup expanded={expanded} icon={expanded ? <FolderOpen size="md" /> : <Folder size="md" />} indented
        key={group.category} label={`${group.category} · ${group.entries.length}`} onToggle={() => toggle(group.category)}>
        {group.entries.map((entry) => <PageRow id={entry.id} key={entry.id} label={entry.meta.title} page={page} onOpen={onOpen} />)}
      </CollapsibleNavGroup>
    );
  });
}

function SearchResults({ entries, page, onOpen }: Omit<ViewerSidebarProps, "query" | "onQueryChange">) {
  if (entries.length === 0) return <EmptyLine message="No components or blocks match." />;
  const sections = [
    { title: "Components", items: entries.filter((entry) => entry.kind === "component") },
    { title: "Blocks", items: entries.filter((entry) => entry.kind === "block") },
  ].filter((section) => section.items.length > 0);
  return sections.map((section) => (
    <NavSection key={section.title} title={`${section.title} (${section.items.length})`}>
      {section.items.map((entry) => <PageRow id={entry.id} key={entry.id} label={entry.meta.title} page={page} onOpen={onOpen} />)}
    </NavSection>
  ));
}

export function ViewerSidebar({ entries, page, query, onQueryChange, onOpen }: ViewerSidebarProps) {
  const results = filterEntries(entries, query);
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") onQueryChange("");
    if (event.key === "Enter" && results[0]) onOpen(results[0].id);
  };
  const row = (id: string, label: string, icon?: ReactNode) => <PageRow icon={icon} id={id} key={id} label={label} page={page} onOpen={onOpen} />;

  return (
    <Stack gap="lg">
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true"><Blocks size="md" /></span>
        <Stack gap="none">
          <Typo.AppTitle>Butler DS</Typo.AppTitle>
          <Typo.Caption tone="secondary">Design system · DS Viewer</Typo.Caption>
        </Stack>
      </div>
      <Input aria-label="Filter components and blocks" id={VIEWER_SEARCH_ID} placeholder="Filter (press /)" type="search"
        value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleKeyDown} />
      {query.trim() ? (
        <Stack gap="lg" data-ds-search-results={results.length}>
          <SearchResults entries={results} page={page} onOpen={onOpen} />
        </Stack>
      ) : (
        <>
          <NavSection title="Start">
            {row("overview", "Overview", <Sparkles size="md" />)}
            {row("guide", "Decision guide", <MagicWand size="md" />)}
            {row("recipes", "Build a screen", <LayoutDashboard size="md" />)}
          </NavSection>
          <NavSection title="Foundations">
            {row("foundations", "Guidebook", <Palette size="md" />)}
            {FOUNDATION_CHAPTERS.map((chapter) => row(chapterPage(chapter), `${chapter.number}  ${chapter.title}`))}
          </NavSection>
          <NavSection title="Components">
            {row("components", "All components")}
            <EntryGroups entries={entries} kind="component" page={page} onOpen={onOpen} />
          </NavSection>
          <NavSection title="Blocks">
            {row("blocks", "All blocks")}
            <EntryGroups entries={entries} kind="block" page={page} onOpen={onOpen} />
          </NavSection>
          <NavSection title="Patterns">
            {row("patterns", "All patterns", <BookOpenText size="md" />)}
            {PATTERNS.map((pattern) => row(`patterns/${pattern.id}`, pattern.title))}
          </NavSection>
          <NavSection title="Assets">
            {row("icons", "Icons", <ImageIcon size="md" />)}
          </NavSection>
        </>
      )}
    </Stack>
  );
}
