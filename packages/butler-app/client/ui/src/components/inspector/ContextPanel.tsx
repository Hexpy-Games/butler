import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { KeyValueRow, ScrollArea, Section, Stack } from "@/butler-ds";
import { ChartContainer } from "@/butler-ds";
import type { ContextDetailsView } from "@/app/types.ts";
import { ContextCategoryRow } from "./ContextCategoryRow.tsx";
import { buildContextChart, formatTokenCount } from "./contextPanelUtils.ts";
import {
  contextLegendContent,
  contextLegendFrame,
  contextSectionInset,
} from "./inspectorLayout.ts";

export function ContextPanel({ context }: { context?: ContextDetailsView }) {
  const contextChart = context ? buildContextChart(context) : null;
  const sortedCategories = context
    ? [...context.categories].sort(
        (left, right) => right.used_tokens - left.used_tokens,
      )
    : [];
  const usedPercent = context
    ? Math.round(Math.min(1, context.ratio) * 100)
    : 0;
  return (
    <Section
      title="Context details"
      gap="md"
      fill
      contentFill
      style={contextSectionInset}
    >
      {context && contextChart ? (
        <Stack gap="md" fill>
          <Stack gap="sm" data-test-class="context-overview">
            <KeyValueRow
              label="Context window"
              value={`${usedPercent}% full`}
              description={`${formatTokenCount(context.used_tokens)} used`}
              meta={`${formatTokenCount(context.budget_tokens)} budget`}
              valueTextSize="caption"
            />
            {context.available_working_context_tokens !== undefined &&
            context.used_working_context_tokens !== undefined ? (
              <KeyValueRow
                label="Working context"
                value={`${formatTokenCount(context.used_working_context_tokens)} used`}
                description={`${formatTokenCount(context.available_working_context_tokens)} available before compaction pressure`}
                detailLayout="stack"
                meta={
                  context.auto_compact_at_tokens
                    ? `auto compact at ${formatTokenCount(context.auto_compact_at_tokens)}`
                    : undefined
                }
                valueTextSize="caption"
              />
            ) : null}
            <ChartContainer
              aria-label="Context window usage chart"
              config={contextChart.config}
              data-density="compact"
              initialDimension={{ width: 320, height: 36 }}
              role="img"
            >
              <BarChart
                accessibilityLayer
                barSize={20}
                data={contextChart.data}
                layout="vertical"
                margin={{ bottom: 0, left: 0, right: 0, top: 0 }}
              >
                <XAxis domain={[0, context.budget_tokens]} hide type="number" />
                <YAxis dataKey="name" hide type="category" />
                {contextChart.segments.map((segment) => (
                  <Bar
                    dataKey={segment.key}
                    fill={`var(--color-${segment.key})`}
                    isAnimationActive={false}
                    key={segment.key}
                    radius={segment.radius}
                    stackId="context"
                  />
                ))}
              </BarChart>
            </ChartContainer>
          </Stack>
          <ScrollArea
            contentStyle={contextLegendContent}
            dataSlot="context-legend-scroll"
            dataTestClass="context-legend-scroll"
            fill
            style={contextLegendFrame}
          >
            <Stack gap="sm" data-test-class="context-legend">
              {sortedCategories.map((category, index) => (
                <ContextCategoryRow
                  category={category}
                  colorIndex={index}
                  key={category.id}
                  totalTokens={context.budget_tokens}
                />
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      ) : (
        <EmptyPanelLine label="Context is unavailable" />
      )}
    </Section>
  );
}
