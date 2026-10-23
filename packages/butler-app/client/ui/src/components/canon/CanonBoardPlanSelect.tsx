import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import type { CanonPlan } from "@/app/canonApi.ts";
import { IconButton, Input, OptionMenu, OptionMenuItem, Popover, PopoverContent, PopoverTrigger, ScrollArea, SelectButton, Stack, Typo, X } from "@/butler-ds";
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
    <PopoverContent align="start" density="list" collisionPadding={{ top: 56, right: 8, left: 8, bottom: bottomInset + 8 }}>
      <Stack gap="sm" data-test-class="canon-plan-chooser" aria-label={copy.plan}>
        <Typo.Label>{copy.plan}</Typo.Label>
        <Stack align="row" cross="center" gap="xs">
          <Input aria-label={copy.searchPlan} placeholder={copy.searchPlan} value={search}
            onChange={event => setSearch(event.target.value)} />
          {search && <IconButton label={copy.clearSearch} onClick={() => setSearch("")}><X /></IconButton>}
        </Stack>
        <ScrollArea maxHeight="xs" dataTestClass="canon-plan-results">
          <OptionMenu title={copy.plan}>
            {filtered.map(plan => <OptionMenuItem key={plan.id ?? "backlog"} label={plan.title} selected={plan.id === value}
              onClick={() => { onChange(plan.id); setOpen(false); setSearch(""); }} />)}
            {filtered.length === 0 && <Typo.Caption>{copy.noResults}</Typo.Caption>}
          </OptionMenu>
        </ScrollArea>
      </Stack>
    </PopoverContent>
  </Popover>;
}
