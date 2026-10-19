import { useState, type Ref } from "react";
import { appCopy } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { FilteredSelectPopover, Popover, PopoverContent, PopoverTrigger, RollingSwap, SelectButton } from "@/butler-ds";
import { usageTokens } from "../usage/usageTimeline";
import { usageTime } from "../conversation/conversationUsage";

export type UsageSession = UsageMonitorView["topSessions"][number];

export function usageSessionTitle(session?: UsageSession): string {
  return session?.title ?? appCopy.sidebar.newChat;
}

export function usageKind(kind: UsageSession["kind"]): string {
  const copy = appCopy.composer.usage;
  return kind === "schedule" ? copy.schedule : kind === "butler" ? copy.butlerTask : copy.chats;
}

export function UsageSessionSelect({ sessions, value, onChange, open, onOpenChange, range, triggerRef }: {
  triggerRef: Ref<HTMLButtonElement>;
  open: boolean; onOpenChange: (open: boolean) => void; range: string;
  sessions: UsageSession[]; value: string | null; onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const copy = appCopy.composer.usage;
  const select = (id: string | null) => { onChange(id); onOpenChange(false); };
  const title = value ? usageSessionTitle(sessions.find(s => s.sessionId === value)) : copy.all;
  const items = sessions.filter(s => (kind === "all" || s.kind === kind) && usageSessionTitle(s).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild><SelectButton ref={triggerRef} size="sm" aria-label={copy.chats}>
      <RollingSwap itemKey={value ?? "all"}>{title}</RollingSwap>
    </SelectButton></PopoverTrigger>
    <PopoverContent width="default" align="start" density="list">
      <FilteredSelectPopover title={copy.chats} searchLabel={copy.search} searchPlaceholder={copy.search}
        searchClearLabel={appCopy.interfaceDetails.clearSearch} searchValue={query} onSearchChange={setQuery}
        filters={[{ id: "all", label: copy.all }, ...(["chat", "schedule", "butler"] as const).map(id => ({ id, label: usageKind(id) }))]}
        activeFilterId={kind} onFilterChange={setKind} emptyLabel={copy.noMatches} resultsMaxRows={7}
        footerTitle={copy.pickerFooter(range)}
        groups={[{ id: "sessions", title: copy.usageOrder, items: [
          ...(!query && kind === "all" ? [{ id: "all", label: copy.all, selected: value === null, onSelect: () => select(null) }] : []),
          ...items.map(s => ({ id: s.sessionId, label: usageSessionTitle(s),
            description: [usageTokens(s.totalTokens), usageKind(s.kind), s.lastUsedMs ? usageTime(new Date(s.lastUsedMs).toISOString()) : null].filter(Boolean).join(" · "),
            selected: value === s.sessionId, onSelect: () => select(s.sessionId) }))] }]} />
    </PopoverContent>
  </Popover>;
}
