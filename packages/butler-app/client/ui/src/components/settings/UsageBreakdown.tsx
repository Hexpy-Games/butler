import { appCopy, getAppLocale } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { Clickable, Inline, ProgressMeter, Stack, Tabs, TabsContent, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import { usageTokens } from "../usage/usageTimeline";
import { usageTime } from "../conversation/conversationUsage";
import { usageKind, usageSessionTitle, type UsageSession } from "./UsageSessionSelect";

interface Row { id: string; title: string; description: string; value: number; }
const percent = (value: number) => new Intl.NumberFormat(getAppLocale(), { style: "percent", maximumFractionDigits: 1 }).format(value);

function BreakdownRows({ rows, total, count = false, selected, onSelect }: {
  rows: Row[]; total: number; count?: boolean; selected?: string | null; onSelect?: (id: string | null) => void;
}) {
  return <Stack gap="sm">{rows.length ? rows.map(row => {
    const share = total ? row.value / total : 0;
    const content = <Stack gap="xs" grow minWidth="0">
      <Inline justify="between" cross="start" wrap={false}>
        <Stack gap="xs" grow minWidth="0"><Typo.Body truncate>{row.title}</Typo.Body>
          <Typo.Caption>{row.description}</Typo.Caption></Stack>
        <Stack gap="xs" cross="end"><Typo.Body numeric="tabular">{count ? new Intl.NumberFormat(getAppLocale()).format(row.value) : usageTokens(row.value)}</Typo.Body>
          <Typo.Caption numeric="tabular">{percent(share)}</Typo.Caption></Stack>
      </Inline>
      <ProgressMeter bare value={share * 100} ariaLabel={`${row.title}: ${percent(share)}`} />
    </Stack>;
    return onSelect ? <Clickable key={row.id} stretch aria-pressed={selected === row.id} onClick={() => onSelect(selected === row.id ? null : row.id)}>{content}</Clickable>
      : <Stack key={row.id}>{content}</Stack>;
  }) : <Typo.Caption>{appCopy.composer.usage.noUsage}</Typo.Caption>}</Stack>;
}

export function UsageBreakdown({ view, sessions, allTotal, selected, onSelect }: {
  view: UsageMonitorView | null; sessions: UsageSession[]; allTotal: number; selected: string | null; onSelect: (id: string | null) => void;
}) {
  const copy = appCopy.composer.usage;
  const count = new Intl.NumberFormat(getAppLocale());
  const sessionRows = sessions.map(s => ({ id: s.sessionId, title: usageSessionTitle(s), value: s.totalTokens,
    description: [usageKind(s.kind), s.lastUsedMs ? usageTime(new Date(s.lastUsedMs).toISOString()) : null].filter(Boolean).join(" · ") }));
  const modelRows = Object.entries(view?.model.byModel ?? {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens).map(([id, v]) => ({
    id, title: id, value: v.totalTokens,
    description: `${copy.requests(count.format(v.requestCount))} · ${copy.cached} ${percent(v.promptTokens ? v.cachedTokens / v.promptTokens : 0)}`,
  }));
  const toolRows = Object.entries(view?.tools.byTool ?? {}).sort((a, b) => b[1].calls - a[1].calls).map(([id, v]) => ({
    id, title: appCopy.guided.tools[id] ?? id, value: v.calls, description: copy.failures(count.format(v.failures)),
  }));
  if (!view?.filters.sessionId && view?.webSearch.requestCount && !view.tools.byTool.web_search) {
    toolRows.push({ id: "web_search", title: appCopy.guided.tools.web_search!, value: view.webSearch.requestCount, description: "" });
    toolRows.sort((a, b) => b.value - a.value);
  }
  const toolTotal = toolRows.reduce((sum, row) => sum + row.value, 0);
  return <Tabs defaultValue="chats" gap="md">
    <TabsList variant="line" aria-label={copy.trend}>
      <TabsTrigger value="chats">{copy.chats}</TabsTrigger><TabsTrigger value="models">{copy.models}</TabsTrigger><TabsTrigger value="tools">{copy.tools}</TabsTrigger>
    </TabsList>
    <TabsContent value="chats"><BreakdownRows rows={sessionRows} total={allTotal} selected={selected} onSelect={onSelect} /></TabsContent>
    <TabsContent value="models"><BreakdownRows rows={modelRows} total={view?.model.totalTokens ?? 0} /></TabsContent>
    <TabsContent value="tools"><BreakdownRows rows={toolRows} total={toolTotal} count /></TabsContent>
  </Tabs>;
}
