import { useState } from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ContextDetailsView, ContextUsageCategory } from "@/app/types.ts";
import { Box, Button, ChartContainer, Collapsible, KeyValueRow, Stack, Tooltip, Typo } from "@/butler-ds";
import { buildContextChart } from "../inspector/contextPanelUtils.ts";
import { compactTokens } from "../usage/compactTokens.ts";

type GroupId = "conversation" | "memory" | "rules" | "base" | "reserve";
const GROUP_IDS: GroupId[] = ["conversation", "memory", "rules", "base", "reserve"];
const ITEM_GROUP: Record<string, GroupId> = {
  working: "conversation", "current-input": "conversation",
  retrieved: "memory", references: "memory", "live-config": "rules",
  static: "base", "runtime-state": "base",
  "output-reserve": "reserve", "tool-reserve": "reserve", "compaction-reserve": "reserve",
};

function groupContext(context: ContextDetailsView) {
  const groups = GROUP_IDS.map(id => ({ id, items: [] as ContextUsageCategory[], tokens: 0 }));
  for (const item of context.categories) {
    const groupId = Object.hasOwn(ITEM_GROUP, item.id) ? ITEM_GROUP[item.id] : "base";
    const group = groups.find(group => group.id === groupId)!;
    group.items.push(item);
    group.tokens += item.used_tokens;
  }
  const chart = buildContextChart({ ...context, categories: groups.filter(group => group.id !== "reserve").map(group => ({
    id: group.id, label: appCopy.sessionInfo.contextGroups[group.id], used_tokens: group.tokens,
    budget_tokens: context.budget_tokens, ratio: context.budget_tokens > 0 ? group.tokens / context.budget_tokens : 0,
    safe_description: appCopy.sessionInfo.contextGroupHints[group.id],
  })) });
  const colors = new Map(chart.segments.flatMap(segment => segment.category_id ? [[segment.category_id, segment.color] as const] : []));
  return { groups, chart, colors };
}

function ContextBar({ context, chart }: { context: ContextDetailsView; chart: ReturnType<typeof buildContextChart> }) {
  return <ChartContainer aria-label={appCopy.interfacePanels.contextChart} config={chart.config} data-density="compact" initialDimension={{ width: 240, height: 20 }} role="img">
    <BarChart accessibilityLayer barSize={12} data={chart.data} layout="vertical" margin={{ bottom: 0, left: 0, right: 0, top: 0 }}>
      <XAxis domain={[0, context.budget_tokens]} hide type="number" />
      <YAxis dataKey="name" hide type="category" />
      {chart.segments.map(segment => <Bar dataKey={segment.key} fill={`var(--color-${segment.key})`} isAnimationActive={false} key={segment.key} radius={segment.radius} stackId="context" />)}
    </BarChart>
  </ChartContainer>;
}

function GroupItems({ items }: { items: ContextUsageCategory[] }) {
  const locale = useAppLocale();
  return <Box paddingStart="lg"><Stack gap="xs" data-test-class="context-group-items">
    {items.map(item => {
      const copy = appCopy.sessionInfo.contextItems;
      const [label, description] = Object.hasOwn(copy, item.id) ? copy[item.id] : [item.label, item.safe_description];
      return <KeyValueRow key={item.id} label={label} description={description} data-context-item={item.id}
        value={compactTokens(item.used_tokens, locale)} detailAlign="start" valueTextSize="caption" />;
    })}
  </Stack></Box>;
}

/** The five categories share the chart palette; reserves never count as occupied context. */
export function ContextCompact({ context }: { context: ContextDetailsView }) {
  const locale = useAppLocale();
  const c = appCopy.sessionInfo;
  const [open, setOpen] = useState(false);
  const { groups, chart, colors } = groupContext(context);
  return <Stack gap="sm" data-test-class="context-compact">
    <ContextBar context={context} chart={chart} />
    <Stack gap={open ? "md" : "xs"}>
      {groups.map(group => <Stack key={group.id} gap="xs" data-context-group={group.id}>
        <Tooltip label={c.contextGroupHints[group.id]} side="left">
          <div><KeyValueRow label={c.contextGroups[group.id]} value={compactTokens(group.tokens, locale)} valueTextSize="caption"
            {...(group.id === "reserve" ? { swatchColor: "var(--context-chart-free)", swatchPattern: "hatched" as const } : { swatchColor: colors.get(group.id) })} /></div>
        </Tooltip>
        <Collapsible open={open}><GroupItems items={group.items} /></Collapsible>
      </Stack>)}
    </Stack>
    <Stack align="row" justify="between" cross="center" gap="sm">
      <Typo.Caption tone="secondary">{context.auto_compact_at_tokens != null ? c.contextCompactAt(compactTokens(context.auto_compact_at_tokens, locale)) : null}</Typo.Caption>
      <Button variant="link" size="xs" text={open ? c.contextLess : c.contextMore} aria-expanded={open} onClick={() => setOpen(value => !value)} />
    </Stack>
  </Stack>;
}
