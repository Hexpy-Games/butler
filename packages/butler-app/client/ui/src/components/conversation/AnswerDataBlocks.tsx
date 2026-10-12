import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { ChartBlock, TableBlock } from "../../../../shared/app-contracts";
import type { AnswerGalleryView } from "../../../../shared/answer-blocks-view";
import { Button, ButtonContainer, ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, CHART_COLORS, chartColor,
  Clickable, Collapsible, CopyButton, IconButton, Library, MarkdownContent, MarkdownTable, MediaFrame, ScrollArea, Stack, Typo } from "@/butler-ds";
import { openLink } from "../browser/browserBridge";
import { answerSource, runAnswerAction, saveAnswerItem } from "./answerBlockActions";
import { appCopy, useAppLocale } from "@/app/copy";

export function AnswerSourceLine({ item }: { item: { source?: string; checked?: string } }) {
  useAppLocale();
  const source = answerSource(item);
  return source ? <Clickable variant="text" aria-label={source.label} onClick={source.onOpen}>
    <Typo.Caption tone="tertiary">{[source.site, source.checked].filter(Boolean).join(" · ")}</Typo.Caption>
  </Clickable> : null;
}

export function AnswerTable({ block }: { block: TableBlock }) {
  useAppLocale();
  const copy = appCopy.conversation.answerBlocks;
  const [expanded, setExpanded] = useState(false);
  const rows = (start: number, end?: number) => block.rows.slice(start, end).map((row, index) => <tr key={start + index}>
    {row.map((cell, column) => column === 0 ? <th key={column} scope="row">{cell}</th> : <td key={column}>{cell}</td>)}</tr>);
  const table = (start: number, end?: number) => <MarkdownContent><MarkdownTable>
    <thead><tr>{block.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows(start, end)}</tbody>
  </MarkdownTable></MarkdownContent>;
  return <Stack gap="sm">{table(0, 10)}
    <Collapsible open={expanded}>{table(10)}</Collapsible>
    {block.rows.length > 10 ? <Button variant="inline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? copy.showLess : copy.showMoreItems(block.rows.length - 10)}</Button> : null}
  </Stack>;
}

export function AnswerGallery({ block }: { block: AnswerGalleryView }) {
  useAppLocale();
  const copy = appCopy.conversation.answerBlocks;
  return <ScrollArea orientation="x"><Stack align="row" gap="sm">
    {block.items.map((item, index) => <Stack key={index} basis="sm" shrink={false} gap="xs">
      <Clickable stretch variant="text" disabled={!item.source} aria-label={item.caption ?? copy.openImage}
        onClick={() => runAnswerAction(() => openLink(item.source!))}>
        <Stack grow gap="none"><MediaFrame src={item.image_url} aspect={block.media ?? "4:5"} alt={item.caption} /></Stack>
      </Clickable>
      {item.caption ? <Typo.Caption>{item.caption}</Typo.Caption> : null}
      <ButtonContainer size="icon-sm">
        <IconButton label={copy.saveToLibrary} onClick={() => runAnswerAction(() => saveAnswerItem({ ...item, title: item.caption ?? copy.image }))}><Library size="sm" /></IconButton>
        <CopyButton label={copy.copy} copiedLabel={copy.copied} text={item.caption ?? item.source ?? item.img} />
      </ButtonContainer>
    </Stack>)}
  </Stack></ScrollArea>;
}

export function AnswerChart({ block }: { block: ChartBlock }) {
  useAppLocale();
  const copy = appCopy.conversation.answerBlocks;
  const series = block.series.map((item, index) => ({ ...item, key: `series${index}`, color: CHART_COLORS[index] }));
  const config = Object.fromEntries(series.map(item => [item.key, { label: item.name, color: chartColor(item.color) }]));
  const data = block.x.map((x, index) => ({ x, ...Object.fromEntries(series.map(item => [item.key, item.values[index]])) }));
  const Plot = block.kind === "bar" ? BarChart : LineChart;
  return <Stack gap="sm">
    <ChartLegend items={series.map(item => ({ key: item.key, label: item.name, color: item.color }))} />
    <ChartContainer size="panel" config={config} aria-label={block.title ?? copy.chart}>
      <Plot accessibilityLayer data={data}>
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis dataKey="x" tickLine={false} axisLine={false} /><YAxis unit={block.unit} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {series.map(item => block.kind === "bar"
          ? <Bar key={item.key} dataKey={item.key} fill={chartColor(item.color)} isAnimationActive={false} />
          : <Line key={item.key} dataKey={item.key} stroke={chartColor(item.color)} isAnimationActive={false} />)}
      </Plot>
    </ChartContainer>
    <AnswerSourceLine item={block} />
  </Stack>;
}
