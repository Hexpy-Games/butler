import { appCopy } from "@/app/copy.ts";
import type { WorkPlanAction } from "@/app/types.ts";

function formatter() {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function workPlanTime(value: string): string {
  return formatter().format(new Date(value));
}

function timeRange(start: string, end: string): string {
  const format = formatter();
  const startParts = format.formatToParts(new Date(start));
  const endParts = format.formatToParts(new Date(end));
  const period = startParts.find(part => part.type === "dayPeriod")?.value;
  if (period && period === endParts.find(part => part.type === "dayPeriod")?.value) {
    const index = endParts.findIndex(part => part.type === "dayPeriod");
    endParts.splice(index, 1);
    if (endParts[0]?.type === "literal") endParts.shift();
    if (endParts.at(-1)?.type === "literal") endParts.pop();
  }
  return `${format.format(new Date(start))}–${endParts.map(part => part.value).join("")}`;
}

export function workPlanStatusTime(action: WorkPlanAction): string {
  const copy = appCopy.conversation.work.planSteps;
  const period = action.status === "done" && action.started_at && action.finished_at
    ? timeRange(action.started_at, action.finished_at)
    : action.status === "active" && action.started_at ? copy.since(workPlanTime(action.started_at)) : "";
  return [copy.statuses[action.status], period].filter(Boolean).join(" · ");
}
