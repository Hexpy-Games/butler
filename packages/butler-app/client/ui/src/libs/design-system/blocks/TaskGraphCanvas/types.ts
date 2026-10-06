import type { ReactNode } from "react";
import type { TaskGraphEdge, TaskGraphStatus } from "../../lib/taskGraphLayout";

export interface TaskGraphNode {
  id: string;
  status: TaskGraphStatus;
}

/** Shared by TaskGraphCanvas (left to right) and TaskGraphLanes (top to bottom). */
export interface TaskGraphViewProps {
  nodes: readonly TaskGraphNode[];
  /** Prerequisite edges (from must finish before to). Unknown ids are ignored. */
  edges: readonly TaskGraphEdge[];
  /** Renders one task, normally a TaskGraphCard. */
  renderNode: (id: string) => ReactNode;
  /** Selected task: kept in view (canvas) and the arrow-key origin. */
  selectedId?: string | null;
  /** Arrow keys move focus and call this with the new task. */
  onSelect?: (id: string) => void;
  /** Accessible name of the graph group. */
  label: string;
}
