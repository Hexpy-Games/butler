import { appCopy, getAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { modelDisplayName, runtimeModels } from "@/app/utils";
import type { UsageMonitorView } from "@/app/types";
import { Box, Button, SkeletonRows, Clickable, Inline, ProgressMeter, Stack, Tabs, TabsContent, TabsList, TabsTrigger, Typo } from "@/butler-ds";
import { usageShare, usageTokens } from "../usage/usageTimeline";
import { usageTime } from "../conversation/conversationUsage";
import { usageProviderName } from "../usage/usageProviderName";
import { usageKind, usageSessionTitle, type UsageSession } from "./UsageSessionSelect";

interface Row { id: string; title: string; description: string; value: number; }
const percent = usageShare;

function BreakdownRows({ rows, total, count = false, selected, onSelect }: {
  rows: Row[]; total: number; count?: boolean; selected?: string | null; onSelect?: (id: string | null) => void;
}) {
  return <Stack gap="sm">{rows.length ? rows.map(row => {
    const share = total ? row.value / total : 0;
    const content = <Box paddingY="sm" grow minWidth="0"><Stack gap="xs" grow minWidth="0">
      <Inline justify="between" cross="start" wrap={false}>
        <Stack gap="xs" grow minWidth="0"><Typo.Body tone="primary" truncate>{row.title}</Typo.Body>
          {row.description ? <Typo.Caption tone="primary">{row.description}</Typo.Caption> : null}</Stack>
        <Stack gap="xs" cross="end"><Typo.Body tone="primary" numeric="tabular">{count ? new Intl.NumberFormat(getAppLocale()).format(row.value) : usageTokens(row.value)}</Typo.Body>
          <Typo.Caption tone="primary" numeric="tabular">{percent(share)}</Typo.Caption></Stack>
      </Inline>
      <ProgressMeter bare value={share * 100} ariaLabel={`${row.title}: ${percent(share)}`} />
    </Stack></Box>;
    return onSelect ? <Clickable key={row.id} bleed="inline" stretch selected={selected === row.id} onClick={() => onSelect(selected === row.id ? null : row.id)}>{content}</Clickable>
      : <Box key={row.id} minWidth="0">{content}</Box>;
  }) : <Typo.Caption>{appCopy.composer.usage.noRecords}</Typo.Caption>}</Stack>;
}

export function UsageBreakdown({ view, sessions, allTotal, selected, onSelect, loading, onShowAll }: {
  loading: boolean; onShowAll: () => void;
  view: UsageMonitorView | null; sessions: UsageSession[]; allTotal: number; selected: string | null; onSelect: (id: string | null) => void;
}) {
  const copy = appCopy.composer.usage;
  const count = new Intl.NumberFormat(getAppLocale());
  const catalog = useButlerStore(store => store.modelCatalog);
  const models = [...catalog.models, ...runtimeModels(catalog)];
  const byId = new Map(models.flatMap(model => [[model.model_ref, model], [model.model_id, model]]));
  const top = sessions.slice(0, 6);
  const extra = sessions.find(s => s.sessionId === selected);
  if (extra && !top.includes(extra)) top.push(extra);
  const sessionRows = top.map(s => ({ id: s.sessionId, title: usageSessionTitle(s), value: s.totalTokens,
    description: [usageKind(s.kind), s.lastUsedMs ? usageTime(new Date(s.lastUsedMs).toISOString()) : null].filter(Boolean).join(" · ") }));
  const modelRows = Object.entries(view?.model.byModel ?? {}).sort((a, b) => b[1].totalTokens - a[1].totalTokens).map(([id, v]) => ({
    id, title: byId.has(id) ? modelDisplayName(byId.get(id)) : id, value: v.totalTokens,
    description: `${byId.get(id)?.provider_label ?? usageProviderName(id.split("/")[0]!)} · ${copy.requests(count.format(v.requestCount))} · ${copy.cached} ${percent(v.promptTokens ? v.cachedTokens / v.promptTokens : 0)}`,
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
    <TabsContent value="chats">{loading ? <SkeletonRows rows={3} label={copy.loading} /> : <Stack gap="sm"><BreakdownRows rows={sessionRows} total={allTotal} selected={selected} onSelect={onSelect} />{sessions.length > 6 ? <Button size="xs" variant="outline" onClick={onShowAll}>{copy.viewAll(sessions.length)}</Button> : null}</Stack>}</TabsContent>
    <TabsContent value="models">{loading ? <SkeletonRows rows={3} label={copy.loading} /> : <BreakdownRows rows={modelRows} total={view?.model.totalTokens ?? 0} />}</TabsContent>
    <TabsContent value="tools">{loading ? <SkeletonRows rows={3} label={copy.loading} /> : <BreakdownRows rows={toolRows} total={toolTotal} count />}</TabsContent>
  </Tabs>;
}
