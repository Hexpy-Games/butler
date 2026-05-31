import type { AgentTurnEvent } from "../../agent/events/turn-events.ts";
import type { TransportCapabilities } from "../../test-support/harness/contracts.ts";

export type TurnEventProjectionMode =
  | "live_activity"
  | "progress_draft"
  | "final_aggregate";

const LIVE_EVENT_KINDS = new Set([
  "assistant.public_note",
  "work.block.started",
  "work.block.updated",
  "work.block.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "guard.started",
  "guard.completed",
  "message.final.started",
  "message.final.completed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
]);

export function turnEventProjectionMode(
  capabilities: TransportCapabilities,
): TurnEventProjectionMode {
  if (capabilities.supportsActivityEvents) return "live_activity";
  if (
    capabilities.supportsProgressDrafts ||
    capabilities.supportsStreamingEdits ||
    capabilities.supportsMessageEdit
  ) {
    return "progress_draft";
  }
  return "final_aggregate";
}

export function shouldProjectTurnEventLive(
  capabilities: TransportCapabilities,
  event: Pick<AgentTurnEvent, "kind" | "visibility">,
): boolean {
  if (event.visibility === "internal") return false;
  if (turnEventProjectionMode(capabilities) !== "live_activity") return false;
  return LIVE_EVENT_KINDS.has(event.kind);
}

export function shouldProjectTurnEventAsProgressDraft(
  capabilities: TransportCapabilities,
  event: Pick<AgentTurnEvent, "kind" | "visibility">,
): boolean {
  if (event.visibility === "internal") return false;
  if (turnEventProjectionMode(capabilities) !== "progress_draft") return false;
  return event.kind.startsWith("tool.") ||
    event.kind.startsWith("guard.") ||
    event.kind === "assistant.public_note";
}

export function finalAggregateSummaryFromTurnEvents(
  events: Array<Pick<AgentTurnEvent, "kind" | "visibility">>,
): string | null {
  const publicEvents = events.filter((event) => event.visibility !== "internal");
  const toolCount = publicEvents.filter((event) => event.kind.startsWith("tool.")).length;
  const guardCompleted = publicEvents.some((event) => event.kind === "guard.completed");
  if (toolCount === 0 && !guardCompleted) return null;
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} safe activity event${toolCount === 1 ? "" : "s"}`);
  if (guardCompleted) parts.push("response checked");
  return parts.join(", ");
}
