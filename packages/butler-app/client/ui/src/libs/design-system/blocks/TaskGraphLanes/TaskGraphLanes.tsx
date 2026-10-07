import { useMemo, useRef, type KeyboardEvent } from "react";
import { indexTaskGraph, laneTaskGraph, layoutTaskGraph, taskGraphEdgeKey, taskGraphEdgeState } from "../../lib/taskGraphLayout";
import type { TaskGraphViewProps } from "../TaskGraphCanvas/types";
import { focusTask, slotOf, useSlotRects } from "../TaskGraphCanvas/useSlotRects";
import styles from "./TaskGraphLanes.module.css";

const PITCH = 14;
const PAD = 7;
const BEND = 8;

/**
 * The phone layout of a task DAG: tasks top to bottom in rank order, full
 * width, with a lane gutter that carries fan-out and join (git-log lanes).
 * Each dot sits on its card's first text line (the centre of the card's
 * IconSlot). Up/Down move focus and selection row by row.
 */
export function TaskGraphLanes({ nodes, edges, renderNode, onSelect, label }: TaskGraphViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const origin = useRef<SVGSVGElement>(null);
  const index = useMemo(() => indexTaskGraph(nodes.map((node) => node.id), edges), [nodes, edges]);
  const lanes = useMemo(() => laneTaskGraph(layoutTaskGraph(index), index), [index]);
  const status = useMemo(() => new Map(nodes.map((node) => [node.id, node.status])), [nodes]);
  const { rects, size } = useSlotRects(host, origin, lanes);
  const x = (lane: number) => PAD + lane * PITCH;
  const y = (id: string) => rects.get(id)?.firstLineY ?? 0;
  const width = PAD * 2 + (lanes.laneCount - 1) * PITCH;
  const ready = lanes.rows.every((id) => rects.has(id));

  const paths = ready ? [...index.succs].flatMap(([from, targets]) => targets.map((to) => {
    const key = taskGraphEdgeKey({ from, to });
    const [xp, xl, xs] = [x(lanes.lane.get(from)!), x(lanes.edgeLane.get(key) ?? lanes.lane.get(to)!), x(lanes.lane.get(to)!)];
    const [yp, ys] = [y(from), y(to)];
    let d = `M ${xp} ${yp}`;
    if (xl !== xp) d += ` C ${xp} ${yp + BEND}, ${xl} ${yp + BEND}, ${xl} ${yp + 2 * BEND}`;
    d += xl === xs ? ` L ${xl} ${ys}` : ` L ${xl} ${ys - 2 * BEND} C ${xl} ${ys - BEND}, ${xs} ${ys - BEND}, ${xs} ${ys}`;
    return <path key={key} d={d} className={styles.edge} data-edge={key} data-edge-state={taskGraphEdgeState(status.get(from)!, status.get(to)!)} />;
  })) : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = slotOf(event.target);
    if (!id || !host.current) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step && focusTask(host.current, lanes.rows[lanes.rows.indexOf(id) + step], onSelect)) event.preventDefault();
  };

  return (
    <div ref={host} className={styles.lanes} role="group" aria-label={label} onKeyDown={onKeyDown}>
      <svg ref={origin} className={styles.gutter} width={width} height={size.height} aria-hidden="true">
        {paths}
        {ready ? lanes.rows.map((id) => (
          <circle key={id} className={styles.dot} data-status={status.get(id)} cx={x(lanes.lane.get(id)!)} cy={y(id)} r={status.get(id) === "running" ? 4.5 : 3.5} />
        )) : null}
      </svg>
      <div className={styles.rows}>
        {lanes.rows.map((id) => <div key={id} data-graph-slot={id}>{renderNode(id)}</div>)}
      </div>
    </div>
  );
}
