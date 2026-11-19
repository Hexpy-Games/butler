import { api } from "./api.ts";
import type { TaskGraphDocument, TaskGraphReadOptions, TaskGraphsPage, TaskGraphSnapshot } from "../../../shared/task-graph-contracts.ts";
export type * from "../../../shared/task-graph-contracts.ts";

function graphPath(path: string, options: TaskGraphReadOptions): string {
  const query = new URLSearchParams();
  if (options.revision) query.set("revision", options.revision);
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  return query.size ? `${path}?${query}` : path;
}
export function getSessionTaskGraphs(sessionId: string, options: TaskGraphReadOptions = {}): Promise<TaskGraphsPage> {
  return api(graphPath(`/sessions/${encodeURIComponent(sessionId)}/task-graphs`, options));
}
export function getPlanTaskGraph(planId: string, options: TaskGraphReadOptions = {}): Promise<TaskGraphSnapshot> {
  return api(graphPath(`/plans/${encodeURIComponent(planId)}/task-graph`, options));
}
export function getTaskDocument(taskId: string, revision?: string): Promise<TaskGraphDocument> {
  return api(graphPath(`/tasks/${encodeURIComponent(taskId)}/document`, { revision }));
}
