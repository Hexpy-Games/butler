import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonTag } from "@/app/canonApi.ts";
import { FilteredSelectPopover, Popover, PopoverContent, PopoverTrigger, SelectButton, Tag } from "@/butler-ds";
export function CanonTagChooser({ tags, value, onChange, onCreate, disabled, filter = false }: {
  tags: CanonTag[]; value: string[]; onChange: (ids: string[]) => void;
  onCreate?: (name: string) => void; disabled?: boolean; filter?: boolean;
}) {
  useAppLocale();
  const copy = appCopy.canon.tags;
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const query = search.trim().normalize("NFC");
  const found = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const items = found.map(tag => ({ id: tag.id, label: <Tag tone={tag.color}>{tag.name}</Tag>, selected: value.includes(tag.id),
    onSelect: () => onChange(value.includes(tag.id) ? value.filter(id => id !== tag.id) : [...value, tag.id]),
  }));
  if (onCreate && query && Array.from(query).length <= 32 && !tags.some(tag => tag.name === query)) {
    items.push({ id: "create", label: <>{copy.create(query)}</>, selected: false,
      onSelect: () => { setOpen(false); setSearch(""); onCreate(query); } });
  }
  return <Popover open={open} onOpenChange={open => { setOpen(open); if (!open) setSearch(""); }}>
    <PopoverTrigger asChild><SelectButton size="sm" role="combobox" aria-expanded={open}
      aria-label={filter ? copy.filter : copy.label} disabled={disabled} count={filter ? value.length || undefined : undefined}>
      {filter ? copy.label : copy.add}
    </SelectButton></PopoverTrigger>
    <PopoverContent align="start" density="list" collisionPadding={8}>
      <FilteredSelectPopover title={filter ? copy.filter : copy.label} searchLabel={copy.search} searchPlaceholder={copy.searchPlaceholder}
        searchClearLabel={appCopy.canon.clearSearch} searchValue={search} onSearchChange={setSearch}
        filters={[]} activeFilterId="all" onFilterChange={() => undefined}
        groups={[{ id: "tags", title: copy.label, items }]} emptyLabel={copy.empty}
        footerOptions={[{ id: "clear", label: copy.clearAll, onSelect: () => onChange([]) }]} />
    </PopoverContent>
  </Popover>;
}
