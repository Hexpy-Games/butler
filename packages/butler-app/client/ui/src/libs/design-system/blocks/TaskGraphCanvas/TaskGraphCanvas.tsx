import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { indexTaskGraph, layoutTaskGraph, taskGraphEdgeState } from "../../lib/taskGraphLayout";
import { ADAPTIVE_MEDIA, useMediaMatch } from "../../responsive";
import { InspectorInset } from "../InspectorShell";
import { ScrollArea } from "../ScrollArea";
import { TaskGraphLanes } from "../TaskGraphLanes";
import type { TaskGraphViewProps } from "./types";
import { focusTask, slotOf, useSlotRects } from "./useSlotRects";
import styles from "./TaskGraphCanvas.module.css";

export interface TaskGraphCanvasProps extends TaskGraphViewProps {
  /**
   * `auto` (default): left to right, and TaskGraphLanes top to bottom at
   * compact (phone) widths. `horizontal` / `vertical` force one layout.
   */
  orientation?: "auto" | "horizontal" | "vertical";
}

/**
 * A read-only task DAG. Desktop: ranked columns left to right inside a
 * horizontal ScrollArea that runs edge to edge in the inspector; the first
 * column rests on the inspector inset. Edges are SVG (satisfied, waiting,
 * failed, into-running) with no motion. The selected task's column is
 * scrolled to the inset when it is out of view.
 */
export function TaskGraphCanvas({ orientation = "auto", ...view }: TaskGraphCanvasProps) {
  const compact = useMediaMatch(ADAPTIVE_MEDIA.compact);
  if (orientation === "vertical" || (orientation === "auto" && compact)) {
    return <InspectorInset><TaskGraphLanes {...view} /></InspectorInset>;
  }
  return <HorizontalGraph {...view} />;
}

function HorizontalGraph({ nodes, edges, renderNode, selectedId, onSelect, label }: TaskGraphViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const origin = useRef<SVGSVGElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const index = useMemo(() => indexTaskGraph(nodes.map((node) => node.id), edges), [nodes, edges]);
  const layout = useMemo(() => layoutTaskGraph(index), [index]);
  const status = useMemo(() => new Map(nodes.map((node) => [node.id, node.status])), [nodes]);
  const { rects, size } = useSlotRects(host, origin, layout);

  // An out-of-view selection scrolls so its column rests where the first column rests (the inset).
  useLayoutEffect(() => {
    const view = scroller.current;
    const slot = (id?: string | null) => (id ? host.current?.querySelector(`[data-graph-slot="${CSS.escape(id)}"]`) : null);
    const card = slot(selectedId)?.getBoundingClientRect();
    const first = slot(layout.columns[0]?.[0]?.id)?.getBoundingClientRect();
    if (!view || !card || !first) return;
    const box = view.getBoundingClientRect();
    if (card.left >= box.left && card.right <= box.right) return;
    const rest = first.left + view.scrollLeft - box.left;
    view.scrollLeft = card.left + view.scrollLeft - box.left - rest;
  }, [selectedId, rects, layout]);

  const paths = [...layout.routes].flatMap(([key, route]) => {
    const points = route.map((id) => rects.get(id));
    if (points.some((point) => !point)) return [];
    let d = `M ${points[0]!.right} ${points[0]!.midY}`;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const bend = Math.max(12, (b.left - a.right) / 2);
      d += ` C ${a.right + bend} ${a.midY}, ${b.left - bend} ${b.midY}, ${b.left} ${b.midY}`;
      if (i < points.length - 1) d += ` L ${b.right} ${b.midY}`;
    }
    const [from, to] = key.split("->") as [string, string];
    const state = taskGraphEdgeState(status.get(from)!, status.get(to)!);
    return [<path key={key} d={d} className={styles.edge} data-edge={key} data-edge-state={state} />];
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = slotOf(event.target);
    if (!id || !host.current) return;
    const column = layout.columns.findIndex((slots) => slots.some((slot) => slot.id === id));
    const tasks = (c: number) => (layout.columns[c] ?? []).flatMap((slot) => (slot.kind === "node" ? [slot.id] : []));
    const here = tasks(column);
    const next = {
      ArrowRight: index.succs.get(id)![0] ?? tasks(column + 1)[0],
      ArrowLeft: index.preds.get(id)![0] ?? tasks(column - 1)[0],
      ArrowDown: here[here.indexOf(id) + 1],
      ArrowUp: here[here.indexOf(id) - 1],
    }[event.key];
    if (focusTask(host.current, next, onSelect)) event.preventDefault();
  };

  return (
    <ScrollArea orientation="x" dataTestClass="task-graph-canvas" scrollRef={scroller}>
      <div ref={host} className={styles.canvas} role="group" aria-label={label} onKeyDown={onKeyDown}>
        <svg ref={origin} className={styles.edges} width={size.width} height={size.height} aria-hidden="true">
          {paths}
        </svg>
        <div className={styles.columns}>
          {layout.columns.map((column, rank) => (
            <div key={rank} className={styles.column}>
              {column.map((slot) => (slot.kind === "node"
                ? <div key={slot.id} data-graph-slot={slot.id}>{renderNode(slot.id)}</div>
                : <div key={slot.id} data-graph-slot={slot.id} className={styles.dummy} aria-hidden="true" />))}
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}
