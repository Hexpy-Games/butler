import { appCopy } from "@/app/copy";
import type { LibraryKind, LibraryView } from "@/app/types";
import { Button, Inline, Input, SegmentedControl, Stack, Tag } from "@/butler-ds";
import { LibraryFilterMenus } from "./LibraryFilterMenus";
import { clearFilters, setFilters, typeSearch, useLibraryFilters } from "./libraryFilters";
import { openLibrary } from "./libraryNav";

const KINDS = ["all", "scrap", "document", "bookmark", "output"] as const;

/** Search, kind, filters and sort; chosen filters as removable chips under it. */
export function LibraryToolbar({ view }: { view: LibraryView }) {
  const copy = appCopy.library;
  const filters = useLibraryFilters();
  const kind = view.section ?? "all";
  const chips = [
    ...filters.tags.map((tag) => ({ key: `t:${tag}`, label: copy.filterChip(copy.tags, tag), clear: () => setFilters({ tags: filters.tags.filter((t) => t !== tag) }) })),
    ...(filters.site ? [{ key: "s", label: copy.filterChip(copy.sites, filters.site), clear: () => setFilters({ site: undefined }) }] : []),
    ...(filters.date ? [{ key: "d", label: copy.filterChip(copy.date, copy.dates[filters.date]), clear: () => setFilters({ date: undefined }) }] : []),
  ];
  return (
    <Stack gap="md" data-test-class="library-toolbar">
      <Input value={filters.text} onChange={(event) => typeSearch(event.target.value)} aria-label={copy.search} placeholder={copy.search} />
      <Inline gap="sm" cross="center" justify="between">
        <SegmentedControl ariaLabel={copy.kindLabel} value={kind}
          options={KINDS.map((value) => ({ value, label: copy.kinds[value] }))}
          onValueChange={(value) => openLibrary(value === "all" ? {} : { section: value as LibraryKind })} />
        <LibraryFilterMenus kind={view.section} group={view.group} />
      </Inline>
      {chips.length ? (
        <Inline gap="xs" cross="center" data-test-class="library-filter-chips">
          {chips.map((chip) => <Tag key={chip.key} onRemove={chip.clear} removeLabel={copy.clearFilters}>{chip.label}</Tag>)}
          <Button size="xs" variant="ghost" onClick={clearFilters}>{copy.clearAll}</Button>
        </Inline>
      ) : null}
    </Stack>
  );
}
