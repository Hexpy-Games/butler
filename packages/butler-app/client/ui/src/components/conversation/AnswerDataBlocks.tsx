import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { ChartBlock, GalleryBlock, TableBlock } from "../../../../shared/app-contracts";
import { Button, ButtonContainer, ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, CHART_COLORS, chartColor,
  Clickable, Collapsible, CopyButton, IconButton, Library, MarkdownContent, MarkdownTable, MediaFrame, ScrollArea, Stack, Typo } from "@/butler-ds";
import { openLink } from "../browser/browserBridge";
import { answerSource, runAnswerAction, saveAnswerItem } from "./answerBlockActions";

export function AnswerSourceLine({ item }: { item: { source?: string; checked?: string } }) {
  const source = answerSource(item);
  return source ? <Clickable variant="text" aria-label={source.label} onClick={source.onOpen}>
    <Typo.Caption tone="tertiary">{[source.site, source.checked].filter(Boolean).join(" · ")}</Typo.Caption>
  </Clickable> : null;
}

export function AnswerTable({ block }: { block: TableBlock }) {
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
      {expanded ? "접기" : `${block.rows.length - 10}개 더 보기`}</Button> : null}
  </Stack>;
}

export function AnswerGallery({ block }: { block: GalleryBlock }) {
  return <ScrollArea orientation="x"><Stack align="row" gap="sm">
    {block.items.map((item, index) => <Stack key={index} basis="sm" shrink={false} gap="xs">
      <Clickable variant="text" disabled={!item.source} aria-label={item.caption ?? "이미지 열기"}
        onClick={() => runAnswerAction(() => openLink(item.source!))}>
        <MediaFrame src={`/assets/${encodeURIComponent(item.img)}`} aspect={block.media ?? "4:5"} alt={item.caption} />
      </Clickable>
      {item.caption ? <Typo.Caption>{item.caption}</Typo.Caption> : null}
      <ButtonContainer size="icon-sm">
        <IconButton label="서랍에 저장" onClick={() => runAnswerAction(() => saveAnswerItem({ ...item, title: item.caption ?? "이미지" }))}><Library size="sm" /></IconButton>
        <CopyButton label="복사" copiedLabel="복사했어요" text={item.caption ?? item.source ?? item.img} />
      </ButtonContainer>
    </Stack>)}
  </Stack></ScrollArea>;
}

export function AnswerChart({ block }: { block: ChartBlock }) {
  const series = block.series.map((item, index) => ({ ...item, key: `series${index}`, color: CHART_COLORS[index] }));
  const config = Object.fromEntries(series.map(item => [item.key, { label: item.name, color: chartColor(item.color) }]));
  const data = block.x.map((x, index) => ({ x, ...Object.fromEntries(series.map(item => [item.key, item.values[index]])) }));
  const Plot = block.kind === "bar" ? BarChart : LineChart;
  return <Stack gap="sm">
    <ChartLegend items={series.map(item => ({ key: item.key, label: item.name, color: item.color }))} />
    <ChartContainer size="panel" config={config} aria-label={block.title ?? "차트"}>
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
