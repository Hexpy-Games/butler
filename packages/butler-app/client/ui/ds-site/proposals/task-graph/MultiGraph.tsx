import { useState, type ReactNode } from "react";
import { Box, DisclosureRow, InspectorInset, Stack } from "@/butler-ds";
import type { ProposalLocale, TaskGraphCopy } from "./copy";
import type { TaskGraph } from "./fixture";
import { defaultOpen, GRAPH_STATUS, graphCounts, graphState } from "./graphs";
import { GraphView } from "./GraphView";
import { statusIcon } from "./TaskCard";

export interface StackedGraphsProps {
  graphs: TaskGraph[];
  copy: TaskGraphCopy;
  locale: ProposalLocale;
  selected: string | null;
  /** The graph that owns the selection; its detail opens under it. */
  selectedGraph: string | null;
  detail: ReactNode;
  renderCard: (id: string) => ReactNode;
  onSelect: (id: string) => void;
}

/**
 * Several graphs (chosen variant A): one DisclosureRow per graph with the default "selection"
 * surface, so the trigger keeps its DS inset inside the row box, hover fills it and an open row
 * keeps the flat selection fill. The graph sits below the row (not in the row's panel), so cards
 * start on the same inspector inset as the row box instead of the panel's title-column indent.
 * Running and failed graphs start open; finished and cancelled ones are folded to one line.
 */
export function StackedGraphs({ graphs, copy, locale, selected, selectedGraph, detail, renderCard, onSelect }: StackedGraphsProps) {
  const [open, setOpen] = useState(() => defaultOpen(graphs));
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const single = graphs.length === 1;
  return (
    // Folded rows keep the DS row rhythm (xs); an open graph gets sm above and below its canvas.
    <Stack gap="xs">
      {graphs.map((graph) => {
        const isOpen = single || open.has(graph.id);
        return (
          <Stack key={graph.id} gap="none" data-test-class="task-graph-group" data-graph-id={graph.id} data-open={isOpen ? "true" : "false"}>
            {single ? null : (
              <InspectorInset>
                <DisclosureRow
                  title={graph.title[locale]}
                  meta={graphCounts(graph, copy)}
                  icon={statusIcon(GRAPH_STATUS[graphState(graph)])}
                  open={isOpen}
                  controlsId={`task-graph-${graph.id}`}
                  onToggle={() => toggle(graph.id)}
                />
              </InspectorInset>
            )}
            {isOpen ? (
              <Box paddingY={single ? "none" : "sm"}>
                <Stack gap="md" id={`task-graph-${graph.id}`}>
                  <GraphView graph={graph} label={graph.title[locale]} selected={selected} renderCard={renderCard} onSelect={onSelect} />
                  {selectedGraph === graph.id ? detail : null}
                </Stack>
              </Box>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}
