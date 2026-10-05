import { useState, type ReactNode } from "react";
import {
  DisclosureRow, InspectorInset, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Stack, Typo,
} from "@/butler-ds";
import type { ProposalLocale, TaskGraphCopy } from "./copy";
import type { TaskGraph } from "./fixture";
import { defaultOpen, GRAPH_STATUS, graphCounts, graphState } from "./graphs";
import { GraphView, usePhone } from "./GraphView";
import { statusIcon } from "./TaskCard";

export interface MultiGraphProps {
  graphs: TaskGraph[];
  copy: TaskGraphCopy;
  locale: ProposalLocale;
  selected: string | null;
  /** The graph that owns the selection, and the detail to show for it. */
  selectedGraph: string | null;
  detail: ReactNode;
  renderCard: (id: string) => ReactNode;
  onSelect: (id: string) => void;
  onPickGraph: (graph: TaskGraph) => void;
}

const glyph = (graph: TaskGraph) => statusIcon(GRAPH_STATUS[graphState(graph)]);

/** A (recommended): one collapsible row per graph; running and failed open, the rest folded. */
export function StackedGraphs({ graphs, copy, locale, selected, selectedGraph, detail, renderCard, onSelect }: MultiGraphProps) {
  const [open, setOpen] = useState(() => defaultOpen(graphs));
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <Stack gap="md">
      {graphs.map((graph) => {
        const isOpen = graphs.length === 1 || open.has(graph.id);
        return (
          <Stack key={graph.id} gap="sm" data-test-class="task-graph-group" data-graph-id={graph.id} data-open={isOpen ? "true" : "false"}>
            {graphs.length > 1 ? (
              <InspectorInset>
                <DisclosureRow title={graph.title[locale]} meta={graphCounts(graph, copy)} icon={glyph(graph)}
                  surface="plain" open={isOpen} controlsId={`task-graph-${graph.id}`} onToggle={() => toggle(graph.id)} />
              </InspectorInset>
            ) : null}
            {isOpen ? (
              <Stack gap="md" id={`task-graph-${graph.id}`}>
                <GraphView graph={graph} label={graph.title[locale]} selected={selected} renderCard={renderCard} onSelect={onSelect} />
                {selectedGraph === graph.id ? detail : null}
              </Stack>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

/** B: a Select lists every graph with its counts; one graph shows at a time. */
export function PickedGraph({ graphs, copy, locale, selected, selectedGraph, detail, renderCard, onSelect, onPickGraph }: MultiGraphProps) {
  const current = graphs.find((graph) => graph.id === selectedGraph) ?? graphs[0]!;
  return (
    <Stack gap="md">
      {graphs.length > 1 ? (
        <InspectorInset>
          <Select value={current.id} onValueChange={(id) => onPickGraph(graphs.find((graph) => graph.id === id)!)}>
            <SelectTrigger aria-label={copy.pickGraph} data-test-class="task-graph-picker"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              {graphs.map((graph) => (
                <SelectItem key={graph.id} value={graph.id} icon={glyph(graph)}>
                  {graph.title[locale]} · {graphCounts(graph, copy)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InspectorInset>
      ) : null}
      <GraphView graph={current} label={current.title[locale]} selected={selected} renderCard={renderCard} onSelect={onSelect} />
      {detail}
    </Stack>
  );
}

/** C: every graph as a labelled band in one canvas, scrolled together (stacked lanes on a phone). */
export function CombinedGraphs({ graphs, copy, locale, selected, detail, renderCard, onSelect }: MultiGraphProps) {
  const phone = usePhone();
  const bands = graphs.map((graph) => (
    <Stack key={graph.id} gap="xs" data-test-class="task-graph-group" data-graph-id={graph.id}>
      <BandLabel graph={graph} copy={copy} locale={locale} inset={phone} />
      <GraphView graph={graph} label={graph.title[locale]} selected={selected} renderCard={renderCard} onSelect={onSelect} bare />
    </Stack>
  ));
  return (
    <Stack gap="md">
      {phone ? <Stack gap="lg">{bands}</Stack> : (
        <ScrollArea orientation="x" dataTestClass="task-graph-canvas"><Stack gap="xl">{bands}</Stack></ScrollArea>
      )}
      {detail}
    </Stack>
  );
}

function BandLabel({ graph, copy, locale, inset }: { graph: TaskGraph; copy: TaskGraphCopy; locale: ProposalLocale; inset: boolean }) {
  const label = (
    <Stack align="row" gap="sm" cross="center">
      <Typo.Label>{graph.title[locale]}</Typo.Label>
      <Typo.Caption tone="tertiary" numeric="tabular">{graphCounts(graph, copy)}</Typo.Caption>
    </Stack>
  );
  return inset ? <InspectorInset>{label}</InspectorInset> : label;
}
