import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { FilteredSelectPopover, Popover, PopoverContent, PopoverTrigger, SelectButton } from "@/butler-ds";
export function CanonBoardPlanSelect({ plans, value, onChange, bottomInset = 0 }: {
  bottomInset?: number; plans: CanonPlan[]; value: string | null; onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const copy = appCopy.canon;
  const options = [...plans, { id: null, title: copy.backlog }];
  const filtered = options.filter(plan => plan.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <Popover open={open} onOpenChange={open => { setOpen(open); if (!open) setSearch(""); }}>
    <PopoverTrigger asChild><SelectButton size="sm" aria-label={copy.plan}>
      {options.find(plan => plan.id === value)?.title ?? copy.backlog}
    </SelectButton></PopoverTrigger>
    <PopoverContent align="start" data-menu-size="fit" collisionPadding={{ top: 56, right: 8, left: 8, bottom: bottomInset + 8 }}>
      <FilteredSelectPopover title={copy.plan} searchLabel={copy.searchPlan} searchPlaceholder={copy.searchPlan}
        searchClearLabel={copy.clearSearch} searchValue={search} onSearchChange={setSearch}
        filters={[]} activeFilterId="" onFilterChange={() => undefined} emptyLabel={copy.noResults} width="fixed"
        groups={[{ id: "plans", items: filtered.map(plan => ({
          id: plan.id ?? "backlog", label: plan.title, selected: plan.id === value,
          onSelect: () => { onChange(plan.id); setOpen(false); setSearch(""); },
        })) }]} />
    </PopoverContent>
  </Popover>;
}
