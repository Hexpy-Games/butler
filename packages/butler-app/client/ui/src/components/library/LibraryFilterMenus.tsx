import { appCopy } from "@/app/copy";
import type { LibraryKind } from "@/app/types";
import {
  ButtonContainer, ChevronsUpDown, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, SelectButton, SlidersHorizontal,
} from "@/butler-ds";
import { useLibraryFacets, useLibraryTags, type DatePreset, type LibrarySort } from "./libraryApi";
import { setFilters, useLibraryFilters } from "./libraryFilters";
import { useLibraryDialogs } from "./libraryDialogs";

const DATES: DatePreset[] = ["today", "week", "month", "year"];
const SORTS: LibrarySort[] = ["new", "old", "name", "site"];

/** Tags (all must match), site, date and sort; each trigger shows how many values are chosen. */
export function LibraryFilterMenus({ kind, group }: { kind?: LibraryKind; group?: string }) {
  const copy = appCopy.library;
  const filters = useLibraryFilters();
  const facets = useLibraryFacets(kind ?? "scrap", group && group !== "none" ? group : undefined);
  const all = useLibraryTags();
  const tags = kind ? facets.tags : all.tags;
  const toggle = (name: string, on: boolean) => setFilters({ tags: on ? [...filters.tags, name] : filters.tags.filter((t) => t !== name) });
  return (
    <ButtonContainer size="sm" data-test-class="library-filters">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><SelectButton size="sm" count={filters.tags.length} data-filter="tags">{copy.tags}</SelectButton></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {tags.map((tag) => (
            <DropdownMenuCheckboxItem key={tag.name} checked={filters.tags.includes(tag.name)} onSelect={(event) => event.preventDefault()}
              onCheckedChange={(on) => toggle(tag.name, on === true)}>{`${tag.name} · ${tag.count}`}</DropdownMenuCheckboxItem>
          ))}
          {tags.length ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => useLibraryDialogs.setState({ tags: true })}><SlidersHorizontal size="sm" />{copy.manageTags}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {kind && facets.sites.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><SelectButton size="sm" count={filters.site ? 1 : 0} data-filter="site">{copy.sites}</SelectButton></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={filters.site ?? ""} onValueChange={(site) => setFilters({ site: site || undefined })}>
              <DropdownMenuRadioItem value="">{copy.kinds.all}</DropdownMenuRadioItem>
              {facets.sites.map((site) => <DropdownMenuRadioItem key={site.site} value={site.site}>{`${site.site} · ${site.count}`}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><SelectButton size="sm" count={filters.date ? 1 : 0} data-filter="date">{copy.date}</SelectButton></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={filters.date ?? ""} onValueChange={(date) => setFilters({ date: (date || undefined) as DatePreset | undefined })}>
            <DropdownMenuRadioItem value="">{copy.anyDate}</DropdownMenuRadioItem>
            {DATES.map((date) => <DropdownMenuRadioItem key={date} value={date}>{copy.dates[date]}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><SelectButton size="sm" data-filter="sort" aria-label={copy.sort}><ChevronsUpDown size="sm" />{copy.sorts[filters.sort]}</SelectButton></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={filters.sort} onValueChange={(sort) => setFilters({ sort: sort as LibrarySort })}>
            {SORTS.map((sort) => <DropdownMenuRadioItem key={sort} value={sort}>{copy.sorts[sort]}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonContainer>
  );
}
