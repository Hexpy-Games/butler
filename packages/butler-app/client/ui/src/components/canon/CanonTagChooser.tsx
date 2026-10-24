import { useState } from "react";
import type { CanonTag } from "@/app/canonApi.ts";
import { FilteredSelectPopover, Popover, PopoverContent, PopoverTrigger, SelectButton, Tag } from "@/butler-ds";
export function CanonTagChooser({ tags, value, onChange, onCreate, disabled, filter = false }: {
  tags: CanonTag[]; value: string[]; onChange: (ids: string[]) => void;
  onCreate?: (name: string) => void; disabled?: boolean; filter?: boolean;
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const query = search.trim().normalize("NFC");
  const found = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const items = found.map(tag => ({ id: tag.id, label: <Tag tone={tag.color}>{tag.name}</Tag>, selected: value.includes(tag.id),
    onSelect: () => onChange(value.includes(tag.id) ? value.filter(id => id !== tag.id) : [...value, tag.id]),
  }));
  if (onCreate && query && Array.from(query).length <= 32 && !tags.some(tag => tag.name === query)) {
    items.push({ id: "create", label: <>‘{query}’ 만들기</>, selected: false,
      onSelect: () => { setOpen(false); setSearch(""); onCreate(query); } });
  }
  return <Popover open={open} onOpenChange={open => { setOpen(open); if (!open) setSearch(""); }}>
    <PopoverTrigger asChild><SelectButton size="sm" role="combobox" aria-expanded={open}
      aria-label={filter ? "태그 필터" : "태그"} disabled={disabled} count={value.length || undefined}>
      {filter ? "태그" : "태그 추가"}
    </SelectButton></PopoverTrigger>
    <PopoverContent align="start" density="list" collisionPadding={8}>
      <FilteredSelectPopover title={filter ? "태그 필터" : "태그"} searchLabel="태그 검색" searchPlaceholder="태그 이름"
        searchClearLabel="검색 지우기" searchValue={search} onSearchChange={setSearch}
        filters={[]} activeFilterId="all" onFilterChange={() => undefined}
        groups={[{ id: "tags", title: "태그", items }]} emptyLabel="태그 없음"
        footerOptions={[{ id: "clear", label: "모두 지우기", onSelect: () => onChange([]) }]} />
    </PopoverContent>
  </Popover>;
}
