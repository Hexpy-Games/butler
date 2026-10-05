import { useLayoutEffect, useState, type RefObject } from "react";
import type { TaskStatus } from "./copy";
import type { TaskEdge, TaskNode } from "./fixture";

// Screen-level SVG edges, drawn inside the DS surface that hosts the graph. Colors are DS tokens;
// there is no motion here (the running emphasis lives in DS components on the card).

export interface Rect { left: number; top: number; right: number; bottom: number; midY: number }

/** Card rects relative to the SVG origin, re-measured when the host resizes. */
export function useCardRects(host: RefObject<HTMLElement | null>, origin: RefObject<SVGSVGElement | null>, deps: unknown[]) {
  const [rects, setRects] = useState<Map<string, Rect>>(new Map());
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const measure = () => {
      const base = origin.current?.getBoundingClientRect();
      if (!base) return;
      const next = new Map<string, Rect>();
      element.querySelectorAll<HTMLElement>("[data-task-id]").forEach((card) => {
        const box = card.getBoundingClientRect();
        next.set(card.dataset.taskId!, {
          left: box.left - base.left, right: box.right - base.left,
          top: box.top - base.top, bottom: box.bottom - base.top, midY: box.top - base.top + box.height / 2,
        });
      });
      setRects(next);
      setSize({ width: element.scrollWidth, height: element.scrollHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll("[data-task-id]").forEach((card) => observer.observe(card));
    measure();
    return () => observer.disconnect();
  }, deps);
  return { rects, size };
}

export type EdgeTone = "done" | "active" | "waiting" | "failed";

/** Solid once the prerequisite is met; the line into a running task uses the worker-active color. */
export function edgeTone(from: TaskNode, to: TaskNode): EdgeTone {
  const failed: TaskStatus[] = ["failed", "cancelled"];
  if (failed.includes(from.status)) return "failed";
  if (from.status !== "completed") return "waiting";
  return to.status === "running" ? "active" : "done";
}

const STROKE: Record<EdgeTone, string> = {
  done: "var(--line-strong)",
  active: "var(--worker-active)",
  waiting: "var(--line-strong)",
  failed: "var(--danger)",
};

export function EdgePath({ d, tone, edge }: { d: string; tone: EdgeTone; edge: TaskEdge }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={STROKE[tone]}
      strokeWidth={tone === "active" ? 2 : 1.25}
      strokeDasharray={tone === "waiting" || tone === "failed" ? "3 4" : undefined}
      strokeLinecap="round"
      data-edge={`${edge.from}->${edge.to}`}
      data-edge-tone={tone}
    />
  );
}
