import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Box, ScrollArea, Stack } from "@/butler-ds";
import { EdgePath, edgeTone, useCardRects } from "./edges";
import type { TaskGraph } from "./fixture";
import type { GraphIndex } from "./layout";

const CARD_WIDTH = 208;

export interface GraphViewProps {
  graph: TaskGraph;
  index: GraphIndex;
  columns: string[][];
  label: string;
  selected: string | null;
  renderCard: (id: string) => ReactNode;
  onSelect: (id: string) => void;
  /** Combined layout: the caller owns one shared horizontal ScrollArea for every band. */
  bare?: boolean;
}

/** Focus moves with the arrows: right/left follow edges, up/down stay in the column. */
function neighbor(key: string, id: string, columns: string[][], index: GraphIndex): string | undefined {
  const column = columns.findIndex((ids) => ids.includes(id));
  const row = columns[column]!.indexOf(id);
  if (key === "ArrowRight") return index.succs.get(id)![0] ?? columns[column + 1]?.[0];
  if (key === "ArrowLeft") return index.preds.get(id)![0] ?? columns[column - 1]?.[0];
  if (key === "ArrowDown") return columns[column]![row + 1];
  if (key === "ArrowUp") return columns[column]![row - 1];
  return undefined;
}

export function moveFocus(event: KeyboardEvent<HTMLElement>, next: (id: string) => string | undefined, onSelect: (id: string) => void) {
  const id = (event.target as HTMLElement).dataset?.taskId;
  const target = id ? next(id) : undefined;
  if (!target) return;
  event.preventDefault();
  event.currentTarget.querySelector<HTMLElement>(`[data-task-id="${target}"]`)?.focus();
  onSelect(target);
}

/** Desktop: ranks left to right inside a horizontal DS ScrollArea (edge fades follow the scroll). */
export function GraphCanvas({ graph, index, columns, label, selected, renderCard, onSelect, bare = false }: GraphViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const origin = useRef<SVGSVGElement>(null);
  const { rects, size } = useCardRects(host, origin, [graph, columns]);
  // Keep the selected card (the running task by default) in view without scrolling the page.
  useLayoutEffect(() => {
    const scroller = host.current?.closest<HTMLElement>('[data-test-class="task-graph-canvas"]');
    const card = selected ? host.current?.querySelector<HTMLElement>(`[data-task-id="${selected}"]`) : null;
    if (!scroller || !card) return;
    const view = scroller.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    if (box.left >= view.left && box.right <= view.right) return;
    scroller.scrollLeft += box.left + box.width / 2 - (view.left + view.width / 2);
  }, [selected, rects.size > 0]);
  const paths = graph.edges.flatMap((edge) => {
    const from = rects.get(edge.from);
    const to = rects.get(edge.to);
    if (!from || !to) return [];
    const bend = Math.max(16, (to.left - from.right) / 2);
    const d = `M ${from.right} ${from.midY} C ${from.right + bend} ${from.midY}, ${to.left - bend} ${to.midY}, ${to.left} ${to.midY}`;
    return [<EdgePath key={`${edge.from}-${edge.to}`} d={d} edge={edge} tone={edgeTone(index.byId.get(edge.from)!, index.byId.get(edge.to)!)} />];
  });
  const body = (
      <div ref={host} role="group" aria-label={label} onKeyDown={(event) => moveFocus(event, (id) => neighbor(event.key, id, columns, index), onSelect)}>
        <Stack gap="none">
          {/* Zero-height layer: the SVG paints first, the transformed columns paint over it. */}
          <Stack gap="none" UNSAFE_style={{ height: 0 }}>
            <svg ref={origin} width={size.width} height={size.height} overflow="visible" aria-hidden="true" pointerEvents="none">
              {paths}
            </svg>
          </Stack>
          <Box paddingX="xs" paddingY="xs">
            <Stack align="row" cross="center" gap="2xl">
              {columns.map((ids, rank) => (
                <Box key={rank} paddingStart={rank === 0 ? "none" : "lg"}>
                  <Stack gap="md" UNSAFE_style={{ width: CARD_WIDTH, transform: "translateZ(0)" }}>
                    {ids.map((id) => <Stack key={id} gap="none">{renderCard(id)}</Stack>)}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Box>
        </Stack>
      </div>
  );
  return bare ? body : <ScrollArea orientation="x" dataTestClass="task-graph-canvas">{body}</ScrollArea>;
}
