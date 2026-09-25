import { useState, type KeyboardEvent } from "react";
import { CollapsibleNavGroup } from "../blocks/CollapsibleNavGroup";
import { NavRow } from "../blocks/NavRow";
import { NavSection } from "../blocks/NavSection";
import { EmptyLine } from "../blocks/EmptyLine";
import { Folder, FolderOpen } from "../components/Icons";
import { Input } from "../components/Input";
import { Stack } from "../components/Stack";
import { Typo } from "../components/Typo";
import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import { filterEntries, groupEntries } from "./viewerNavigation";

export const VIEWER_SEARCH_ID = "ds-viewer-search";

interface ViewerSidebarProps {
  entries: ShowcaseEntry[];
  page: string;
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (page: string) => void;
}

function PageRow({ id, label, page, onOpen }: {
  id: string;
  label: string;
  page: string;
  onOpen: (page: string) => void;
}) {
  return (
    <div data-ds-nav-item={id}>
      <NavRow label={label} active={page === id} onClick={() => onOpen(id)} />
    </div>
  );
}

function EntryGroups({ entries, kind, page, onOpen }: {
  entries: ShowcaseEntry[];
  kind: ShowcaseEntry["kind"];
  page: string;
  onOpen: (page: string) => void;
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
      <CollapsibleNavGroup
        expanded={expanded}
        icon={expanded ? <FolderOpen size="md" /> : <Folder size="md" />}
        indented
        key={group.category}
        label={group.category}
        onToggle={() => toggle(group.category)}
      >
        {group.entries.map((entry) => (
          <PageRow id={entry.id} key={entry.id} label={entry.meta.title} page={page} onOpen={onOpen} />
        ))}
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
      {section.items.map((entry) => (
        <PageRow id={entry.id} key={entry.id} label={entry.meta.title} page={page} onOpen={onOpen} />
      ))}
    </NavSection>
  ));
}

export function ViewerSidebar({ entries, page, query, onQueryChange, onOpen }: ViewerSidebarProps) {
  const results = filterEntries(entries, query);
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") onQueryChange("");
    if (event.key === "Enter" && results[0]) onOpen(results[0].id);
  };

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Typo.AppTitle>Butler DS Viewer</Typo.AppTitle>
        <Typo.Caption>Design-system showcase</Typo.Caption>
      </Stack>
      <Input
        aria-label="Search components and blocks"
        id={VIEWER_SEARCH_ID}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search (press /)"
        type="search"
        value={query}
      />
      {query.trim() ? (
        <Stack gap="lg" data-ds-search-results={results.length}>
          <SearchResults entries={results} page={page} onOpen={onOpen} />
        </Stack>
      ) : (
        <>
          <NavSection title="Guide">
            <PageRow id="overview" label="Overview" page={page} onOpen={onOpen} />
            <PageRow id="foundations" label="Foundations" page={page} onOpen={onOpen} />
          </NavSection>
          <NavSection title="Components">
            <PageRow id="components" label="All components" page={page} onOpen={onOpen} />
            <EntryGroups entries={entries} kind="component" page={page} onOpen={onOpen} />
          </NavSection>
          <NavSection title="Blocks">
            <PageRow id="blocks" label="All blocks" page={page} onOpen={onOpen} />
            <EntryGroups entries={entries} kind="block" page={page} onOpen={onOpen} />
          </NavSection>
          <NavSection title="More">
            <PageRow id="patterns" label="Patterns" page={page} onOpen={onOpen} />
            <PageRow id="icons" label="Icons" page={page} onOpen={onOpen} />
          </NavSection>
        </>
      )}
    </Stack>
  );
}
