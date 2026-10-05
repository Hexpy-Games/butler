import { useMemo, useRef } from "react";
import { Stack } from "@/butler-ds";
import { EdgePath, edgeTone, useCardRects } from "./edges";
import { moveFocus, type GraphViewProps } from "./GraphCanvas";
import { edgeKey, laneLayout } from "./layout";
import type { TaskStatus } from "./copy";

const LANE = 14;
const PAD = 7;
/** Dot on the card's first text line: card padding (8) + half the body line (10). */
const FIRST_LINE = 18;

const DOT_FILL: Partial<Record<TaskStatus, string>> = {
  running: "var(--worker-active)", completed: "var(--line-strong)", failed: "var(--danger)",
  blocked: "var(--color-warning)", awaiting_review: "var(--accent)",
};

/** Phone: the same graph top to bottom; a lane gutter carries fan-out and join beside full-width cards. */
export function GraphLanes({ graph, index, columns, label, renderCard, onSelect }: GraphViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const origin = useRef<SVGSVGElement>(null);
  const lanes = useMemo(() => laneLayout(columns, index), [columns, index]);
  const { rects, size } = useCardRects(host, origin, [graph, columns]);
  const x = (lane: number) => PAD + lane * LANE;
  const y = (id: string) => (rects.get(id)?.top ?? 0) + FIRST_LINE;
  const width = PAD * 2 + (lanes.laneCount - 1) * LANE;
  const ready = rects.size === graph.nodes.length;

  const paths = ready ? graph.edges.map((edge) => {
    const lane = lanes.edgeLane.get(edgeKey(edge)) ?? lanes.lane.get(edge.to)!;
    const [xp, xl, xs] = [x(lanes.lane.get(edge.from)!), x(lane), x(lanes.lane.get(edge.to)!)];
    const [yp, ys] = [y(edge.from), y(edge.to)];
    let d = `M ${xp} ${yp}`;
    d += xl === xp ? "" : ` C ${xp} ${yp + 8}, ${xl} ${yp + 8}, ${xl} ${yp + 16}`;
    d += xl === xs ? ` L ${xl} ${ys}` : ` L ${xl} ${ys - 16} C ${xl} ${ys - 8}, ${xs} ${ys - 8}, ${xs} ${ys}`;
    return <EdgePath key={edgeKey(edge)} d={d} edge={edge} tone={edgeTone(index.byId.get(edge.from)!, index.byId.get(edge.to)!)} />;
  }) : null;

  const rowOf = (id: string, step: number) => lanes.rows[lanes.rows.indexOf(id) + step];
  return (
    <div ref={host} role="group" aria-label={label}
      onKeyDown={(event) => moveFocus(event, (id) => (event.key === "ArrowDown" ? rowOf(id, 1) : event.key === "ArrowUp" ? rowOf(id, -1) : undefined), onSelect)}>
      <Stack align="row" gap="sm" cross="start">
        <Stack gap="none" shrink={false} UNSAFE_style={{ width }}>
          <svg ref={origin} width={width} height={size.height} overflow="visible" aria-hidden="true" pointerEvents="none">
            {paths}
            {ready ? lanes.rows.map((id) => {
              const status = index.byId.get(id)!.status;
              const fill = DOT_FILL[status];
              return (
                <circle key={id} cx={x(lanes.lane.get(id)!)} cy={y(id)} r={status === "running" ? 4.5 : 3.5}
                  fill={fill ?? "var(--surface-raised)"} stroke={fill ?? "var(--line-strong)"} strokeWidth={1.25} />
              );
            }) : null}
          </svg>
        </Stack>
        <Stack gap="sm" grow minWidth="0">
          {lanes.rows.map((id) => <Stack key={id} gap="none">{renderCard(id)}</Stack>)}
        </Stack>
      </Stack>
    </div>
  );
}
