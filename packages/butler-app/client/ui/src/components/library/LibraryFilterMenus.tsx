import { appCopy } from "@/app/copy";
import type { LibraryKind } from "@/app/types";
import {
  Box, ButtonContainer, ChevronsUpDown, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, SelectButton, SlidersHorizontal,
} from "@/butler-ds";
import { useLibraryFacets, useLibraryTags, type DatePreset, type LibrarySort } from "./libraryApi";
import { setFilters, useLibraryFilters } from "./libraryFilters";
import { useLibraryDialogs } from "./libraryDialogs";
import { DateRangeFields } from "./DateRangeFields";

const DATES: DatePreset[] = ["today", "week", "month", "year"];
const SORTS: LibrarySort[] = ["new", "old", "name", "site"];

/** Tags (all must match), site, date and sort; each trigger shows how many values are chosen. */
export function LibraryFilterMenus({ kind, group }: { kind?: LibraryKind; group?: string }) {
  const copy = appCopy.library;
  const filters = useLibraryFilters();
  const facets = useLibraryFacets(kind ?? "scrap", group);
  const documents = useLibraryFacets("document", undefined, !kind);
  const bookmarks = useLibraryFacets("bookmark", undefined, !kind);
  const outputs = useLibraryFacets("output", undefined, !kind);
  const sites = kind ? facets.sites : [...new Set([facets, documents, bookmarks, outputs].flatMap((f) => f.sites.map((s) => s.site)))].sort().map((site) => ({ site, count: [facets, documents, bookmarks, outputs].flatMap((f) => f.sites).filter((s) => s.site === site).reduce((n, s) => n + s.count, 0) }));
  const all = useLibraryTags();
  const tags = kind ? facets.tags : all.tags;
  const toggle = (name: string, on: boolean) => setFilters({ tags: on ? [...filters.tags, name] : filters.tags.filter((t) => t !== name) });
  return (
    <ButtonContainer size="sm" data-test-class="library-filters">
      <DropdownMenu>
        <Box shrink={false} basis="content"><DropdownMenuTrigger asChild><SelectButton size="sm" count={filters.tags.length} data-filter="tags">{copy.tags}</SelectButton></DropdownMenuTrigger></Box>
        <DropdownMenuContent align="end">
          {tags.map((tag) => (
            <DropdownMenuCheckboxItem key={tag.name} checked={filters.tags.includes(tag.name)} onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => toggle(tag.name, on === true)}>{`${tag.name} · ${tag.count}`}</DropdownMenuCheckboxItem>
          ))}
          {tags.length ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => useLibraryDialogs.setState({ tags: true })}><SlidersHorizontal size="sm" />{copy.manageTags}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {sites.length ? (
        <DropdownMenu>
          <Box shrink={false} basis="content"><DropdownMenuTrigger asChild><SelectButton size="sm" count={filters.site ? 1 : 0} data-filter="site">{copy.sites}</SelectButton></DropdownMenuTrigger></Box>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={filters.site ?? ""} onValueChange={(site) => setFilters({ site: site || undefined })}>
              <DropdownMenuRadioItem value="">{copy.kinds.all}</DropdownMenuRadioItem>
              {sites.map((site) => <DropdownMenuRadioItem key={site.site} value={site.site}>{`${site.site} · ${site.count}`}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <Box shrink={false} basis="content"><DropdownMenuTrigger asChild><SelectButton size="sm" count={filters.date || filters.since || filters.until ? 1 : 0} data-filter="date">{copy.date}</SelectButton></DropdownMenuTrigger></Box>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={filters.date ?? ""} onValueChange={(date) => setFilters({ date: (date || undefined) as DatePreset | undefined, since: undefined, until: undefined })}>
            <DropdownMenuRadioItem value="">{copy.anyDate}</DropdownMenuRadioItem>
            {DATES.map((date) => <DropdownMenuRadioItem key={date} value={date}>{copy.dates[date]}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DateRangeFields />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <Box shrink={false} basis="content"><DropdownMenuTrigger asChild><SelectButton size="sm" data-filter="sort" aria-label={copy.sort}><ChevronsUpDown size="sm" />{copy.sorts[filters.sort]}</SelectButton></DropdownMenuTrigger></Box>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={filters.sort} onValueChange={(sort) => setFilters({ sort: sort as LibrarySort })}>
            {SORTS.map((sort) => <DropdownMenuRadioItem key={sort} value={sort}>{copy.sorts[sort]}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonContainer>
  );
}
