import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { FilteredSelectPopover, Popover, PopoverContent, PopoverTrigger, SelectButton } from "@/butler-ds";
export function CanonBoardPlanSelect({ plans, value, onChange }: {
  plans: CanonPlan[]; value: string | null; onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const copy = appCopy.canon;
  const options = [...plans, { id: null, title: copy.backlog }];
  const filtered = options.filter(plan => plan.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <Popover open={open} onOpenChange={open => { setOpen(open); if (!open) setSearch(""); }}>
    <PopoverTrigger asChild><SelectButton size="sm" aria-label={copy.plan}>
      {options.find(plan => plan.id === value)?.title ?? copy.backlog}
    </SelectButton></PopoverTrigger>
    <PopoverContent align="start" density="list">
      <FilteredSelectPopover title={copy.plan} searchLabel={copy.searchPlan} searchPlaceholder={copy.searchPlan}
        searchClearLabel={copy.clearSearch} searchValue={search} onSearchChange={setSearch}
        filters={[]} activeFilterId="" onFilterChange={() => {}} emptyLabel={copy.noResults}
        groups={[{ id: "plans", title: copy.plan, items: filtered.map(plan => ({
          id: plan.id ?? "backlog", label: plan.title, selected: plan.id === value,
          onSelect: () => { onChange(plan.id); setOpen(false); setSearch(""); },
        })) }]} />
    </PopoverContent>
  </Popover>;
}
