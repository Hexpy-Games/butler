import { appCopy } from "@/app/copy";
import type { LibraryKind, LibraryView } from "@/app/types";
import { Button, ChevronRight, EmptyLine, Grid, Section, Typo } from "@/butler-ds";
import type { LibraryItem } from "../browser/libraryStore";
import { GroupTiles } from "./GroupTiles";
import { LibraryItemCard } from "./LibraryItemCard";
import { hasGroups, useLibraryFacets, useLibraryGroups, useLibraryItems } from "./libraryApi";
import { filtersActive, useLibraryFilters } from "./libraryFilters";
import { openLibrary } from "./libraryNav";
import { useCardColumns } from "./useCardColumns";

const KINDS: LibraryKind[] = ["scrap", "document", "bookmark", "output"];
export const CARD_COLUMNS = { compact: "2", base: "3", wide: "4" } as const;

/** The 서랍 main screen: per kind, group tiles and ungrouped items (scraps, bookmarks) or the latest row, each with “View all”. */
export function LibraryMain({ view, onAttach }: { view: LibraryView; onAttach: (item: LibraryItem) => void }) {
  const { ref, columns } = useCardColumns();
  return <Grid columns="1" gap="xl" ref={ref}>{KINDS.map((kind) => <MainSection key={kind} kind={kind} columns={columns} view={view} onAttach={onAttach} />)}</Grid>;
}

function MainSection({ kind, columns, view, onAttach }: { kind: LibraryKind; columns: number; view: LibraryView; onAttach: (item: LibraryItem) => void }) {
  const copy = appCopy.library;
  const filters = useLibraryFilters();
  const filtered = filtersActive(filters);
  const grouped = hasGroups(kind) && !filtered;
  const groups = useLibraryGroups(grouped && hasGroups(kind) ? kind : null);
  const facets = useLibraryFacets(kind);
  const page = useLibraryItems({ kind, group: grouped ? "none" : undefined, q: filters.q, tags: filters.tags, date: filters.date, sort: filters.sort });
  const row = page.items.slice(0, columns);
  const total = filtered ? page.items.length : facets.total;
  const limit = columns === 2 ? 4 : columns;
  const loose = grouped ? groups.ungrouped : total;
  const empty = !page.loading && !row.length && !(grouped && groups.groups.length);
  if (filtered && empty) return null;
  const words = hasGroups(kind) ? copy.groups[kind] : undefined;
  return (
    <Section data-library-kind={kind} title={<>{copy.kinds[kind]} <Typo.Caption tone="tertiary">{filtered && page.next ? `${total}+` : total}</Typo.Caption></>}
      actions={<Button size="xs" variant="ghost" iconEnd={<ChevronRight size="sm" />} onClick={() => openLibrary({ section: kind })}>{copy.viewAll}</Button>}>
      {grouped && hasGroups(kind) && groups.groups.length ? (
        <Grid columns={CARD_COLUMNS} gap="md" data-test-class="library-group-tiles"><GroupTiles kind={kind} groups={groups.groups} limit={limit} /></Grid>
      ) : null}
      {grouped && row.length && groups.groups.length ? <Typo.Text tone="secondary">{words?.ungrouped} <Typo.Caption tone="tertiary">{loose}</Typo.Caption></Typo.Text> : null}
      {row.length ? (
        <Grid columns={CARD_COLUMNS} gap="md">{row.map((item) => <LibraryItemCard key={item.id} item={item} view={view} onAttach={() => onAttach(item)} />)}</Grid>
      ) : null}
      {empty ? <EmptyLine message={page.failed ? copy.failed : copy.noItems} /> : null}
    </Section>
  );
}
