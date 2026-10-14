import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { ChartBlock, TableBlock } from "../../../../shared/app-contracts";
import type { AnswerGalleryView } from "../../../../shared/answer-blocks-view";
import { Button, ButtonContainer, ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, CHART_COLORS, chartColor,
  animateMotion, motionDuration, Clickable, Collapsible, CopyButton, IconButton, Library, MarkdownContent, MarkdownTable, MediaFrame, ScrollArea, Skeleton, Stack, Typo } from "@/butler-ds";
import { AnswerItem, useAnswerItemRef } from "./AnswerItem";
import { faviconSrc } from "@/app/favicons";
import { openImageViewer } from "../media/imageViewerState";
import { answerImages, answerPart, answerSource, runAnswerAction, saveAnswerItem, useAnswerSession } from "./answerBlockActions";
import { appCopy, useAppLocale } from "@/app/copy";

export const AnswerSourceLine = memo(function AnswerSourceLine({ item }: { item: { source?: string; checked?: string } }) {
  useAppLocale();
  const source = answerSource(item, useAnswerSession());
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current || !item.source) return;
    const animation = animateMotion(ref.current, [{ opacity: 0 }, { opacity: 1 }], {
      duration: "fast", delay: motionDuration("stagger-row"), fill: "backwards",
    });
    return () => animation?.cancel();
  }, [item.source, item.checked]);
  return source ? <div ref={ref}><Clickable variant="text" aria-label={source.label} onClick={source.onOpen}>
    <Typo.Caption tone="tertiary">{[source.site, source.checked].filter(Boolean).join(" · ")}</Typo.Caption>
  </Clickable></div> : null;
});

function AnswerRow({ row, superseded }: { row: TableBlock["rows"][number]; superseded: boolean }) {
  const ref = useAnswerItemRef<HTMLTableRowElement>(superseded);
  return <tr ref={ref} data-answer-superseded={superseded || undefined}>
    {row.map((cell, column) => column === 0 ? <th key={column} scope="row"><Typo.Text as="div" wrap="normal" maxWidth="full">{cell}</Typo.Text></th>
      : <td key={column}><Typo.Text as="div" wrap="anywhere" maxWidth="full">{cell}</Typo.Text></td>)}
  </tr>;
}

export const AnswerTable = memo(function AnswerTable({ block, streaming = false, incoming }: { block: TableBlock; streaming?: boolean; incoming?: unknown[] }) {
  useAppLocale();
  const copy = appCopy.conversation.answerBlocks;
  const [expanded, setExpanded] = useState(false);
  const rows = (start: number, end?: number) => block.rows.slice(start, end).map((row, index) =>
    <AnswerRow key={start + index} row={row} superseded={incoming !== undefined && !incoming.includes(row)} />);
  const table = (start: number, end?: number) => <MarkdownContent><MarkdownTable>
    <thead><tr>{block.columns.map((column, index) => <th key={index} scope="col"><Typo.Text as="div" wrap="normal" weight="medium" maxWidth="full">{column}</Typo.Text></th>)}</tr></thead>
    <tbody>{rows(start, end)}{streaming && start === 0 ? <tr><td colSpan={block.columns.length}><Skeleton height="row" width="full" /></td></tr> : null}</tbody>
  </MarkdownTable></MarkdownContent>;
  return <Stack gap="sm">{table(0, 10)}
    <Collapsible open={expanded}>{table(10)}</Collapsible>
    {block.rows.length > 10 ? <Button variant="inline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? copy.showLess : copy.showMoreItems(block.rows.length - 10)}</Button> : null}
  </Stack>;
});

/** Each picture opens the viewer on the gallery's pictures; the viewer opens its source page. */
export const AnswerGallery = memo(function AnswerGallery({ block, incoming }: { block: AnswerGalleryView; incoming?: unknown[] }) {
  useAppLocale();
  const copy = appCopy.conversation.answerBlocks;
  const sessionId = useAnswerSession();
  const images = useMemo(() => answerImages(block.items, sessionId, copy.image), [block.items, sessionId, copy.image]);
  return <ScrollArea orientation="x"><Stack align="row" gap="sm">
    {block.items.map((item, index) => <Stack key={index} basis="sm" shrink={false} gap="xs" data-answer-item=""><AnswerItem superseded={incoming !== undefined && !incoming.includes(item)}><Stack gap="xs">
      <Clickable stretch variant="text" disabled={!images[index]?.src} aria-label={appCopy.conversation.imageViewer.viewImage(item.caption ?? copy.image)}
        onClick={() => openImageViewer(images, index)}>
        <Stack grow gap="none"><MediaFrame src={images[index]?.src || undefined} aspect={block.media ?? "1:1"} fit="cover" placeholder
          placeholderIcon={item.source ? faviconSrc(item.source) : undefined} alt={item.caption} /></Stack>
      </Clickable>
      {item.caption ? <Typo.Caption>{item.caption}</Typo.Caption> : null}
      <ButtonContainer size="icon-sm">
        <IconButton label={copy.saveToLibrary} onClick={(event) => { const part = answerPart(event.currentTarget); runAnswerAction(() => saveAnswerItem({ ...item, title: item.caption ?? copy.image }, sessionId, part)); }}><Library size="sm" /></IconButton>
        <CopyButton label={copy.copy} copiedLabel={copy.copied} text={item.caption ?? item.source ?? item.img} />
      </ButtonContainer>
    </Stack></AnswerItem></Stack>)}
  </Stack></ScrollArea>;
});

export const AnswerChart = memo(function AnswerChart({ block }: { block: ChartBlock }) {
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
});
