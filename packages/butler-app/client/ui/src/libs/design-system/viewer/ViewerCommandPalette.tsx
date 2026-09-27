import { useMemo, useState, type ReactNode } from "react";
import { CommandPalettePanel } from "../blocks/CommandPanel";
import { Blocks, BookOpenText, FileText, LayoutDashboard, MagicWand, Palette, Sparkles } from "../components/Icons";
import type { ShowcaseEntry } from "../showcase/collectShowcaseEntries";
import { tokenCatalog } from "./foundations/catalog";
import { buildSearchIndex, searchItems, type SearchKind } from "./searchIndex";
import type { ViewerState } from "./viewerState";

const ICONS: Record<SearchKind, ReactNode> = {
  page: <FileText size="md" />, component: <Sparkles size="md" />, block: <Blocks size="md" />, token: <Palette size="md" />,
  pattern: <BookOpenText size="md" />, recipe: <LayoutDashboard size="md" />, guide: <MagicWand size="md" />,
};

/** Cmd+K: search every page, component, block, token, pattern, recipe and decision. */
export function ViewerCommandPalette({ entries, open, onClose, onOpen }: {
  entries: ShowcaseEntry[];
  open: boolean;
  onClose: () => void;
  onOpen: (page: string) => void;
  onChange: (patch: Partial<ViewerState>) => void;
}) {
  const [query, setQuery] = useState("");
  const index = useMemo(() => buildSearchIndex(entries, tokenCatalog), [entries]);
  const results = open ? searchItems(index, query) : [];
  const close = () => { onClose(); setQuery(""); };
  return (
    <CommandPalettePanel
      closeLabel="Close"
      feedback={open && query && results.length === 0 ? "Nothing matches. Try a component, token or need (for example: confirm)." : undefined}
      items={results.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        icon: ICONS[item.kind],
        onSelect: () => { onOpen(item.target); close(); },
      }))}
      label="Search the design system"
      onClose={close}
      onQueryChange={setQuery}
      open={open}
      placeholder="Search components, tokens, patterns, or describe what you need"
      query={query}
    />
  );
}
