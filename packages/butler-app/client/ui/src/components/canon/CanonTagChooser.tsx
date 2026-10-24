import { useState, type ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonTag } from "@/app/canonApi.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, FilteredSelectPopover, IconButton, Pencil, Popover, PopoverContent,
  PopoverTrigger, SelectButton, Tag } from "@/butler-ds";
import type { TagAction } from "./CanonTagManageDialog.tsx";
export function CanonTagChooser({ tags, value, onChange, onCreate, onManage, disabled, filter = false, chips, align = "start" }: {
  tags: CanonTag[]; value: string[]; onChange: (ids: string[]) => void;
  onCreate?: (name: string) => void; onManage?: (tag: CanonTag, action: TagAction) => void; disabled?: boolean; filter?: boolean;
  /** Property-row use: the chosen tags are the trigger's own content. */ chips?: ReactNode; align?: "start" | "end";
}) {
  useAppLocale();
  const copy = appCopy.canon.tags;
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const manage = (tag: CanonTag, action: TagAction) => { setOpen(false); setSearch(""); onManage?.(tag, action); };
  const query = search.trim().normalize("NFC");
  const found = tags.filter(tag => tag.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const items = found.map(tag => ({ id: tag.id, label: <Tag tone={tag.color}>{tag.name}</Tag>, selected: value.includes(tag.id),
    onSelect: () => { if (!disabled) onChange(value.includes(tag.id) ? value.filter(id => id !== tag.id) : [...value, tag.id]); },
    // Management lives in the editable tag field only; the board filter passes no onManage.
    actions: onManage && <DropdownMenu>
      <DropdownMenuTrigger asChild><IconButton label={copy.menu(tag.name)} disabled={disabled}><Pencil size="sm" /></IconButton></DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8}>
        <DropdownMenuItem onSelect={() => manage(tag, "rename")}>{copy.rename}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => manage(tag, "color")}>{copy.recolor}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => manage(tag, "delete")}>{copy.remove}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  }));
  if (onCreate && query && Array.from(query).length <= 32 && !tags.some(tag => tag.name === query)) {
    items.push({ id: "create", label: <>{copy.create(query)}</>, selected: false, actions: undefined,
      onSelect: () => { if (disabled) return; setOpen(false); setSearch(""); onCreate(query); } });
  }
  return <Popover open={open} onOpenChange={open => { setOpen(open); if (!open) setSearch(""); }}>
    <PopoverTrigger asChild><SelectButton size="sm" role="combobox" aria-expanded={open}
      aria-label={filter ? copy.filter : copy.label} disabled={disabled} count={filter ? value.length || undefined : undefined}>
      {chips ?? (filter ? copy.label : copy.add)}
    </SelectButton></PopoverTrigger>
    <PopoverContent align={align} density="list" collisionPadding={8}>
      <FilteredSelectPopover title={filter ? copy.filter : copy.label} searchLabel={copy.search} searchPlaceholder={copy.searchPlaceholder}
        searchClearLabel={appCopy.canon.clearSearch} searchValue={search} onSearchChange={setSearch}
        filters={[]} activeFilterId="all" onFilterChange={() => undefined}
        groups={[{ id: "tags", title: copy.label, items }]} emptyLabel={copy.empty}
        footerOptions={[{ id: "clear", label: copy.clearAll, onSelect: () => { if (!disabled) onChange([]); } }]} />
    </PopoverContent>
  </Popover>;
}
