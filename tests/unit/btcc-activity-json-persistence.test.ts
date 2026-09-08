import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteBtccProgressEventRepository } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-btcc-progress-event-repository.ts";
import { createGuidedActivityProjection, projectTurnProgressToEvents } from "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { projectStewardActivityRows } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";
import { projectTurnActivity } from "../../packages/butler-app/client/ui/src/app/conversation-progress/index.ts";

test("accepted plan, unlabelled search and checkpoint persist into Steward execution activity", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const repository = new SqliteBtccProgressEventRepository(db);
  const failures: string[] = [];
  const progress = projectTurnProgressToEvents(event => {
    try {
      repository.append({ sessionId: "steward-json", turnId: "turn-json", event,
        destination: { transport: "app", accountId: "local", peer: { kind: "dm", id: "parent" }, replyToMessageId: "anchor" } });
    } catch (error) {
      failures.push(String(error));
      throw error;
    }
  });
  const activity = createGuidedActivityProjection({ turnId: "turn-json", managedInitially: true, progress });
  const observe = async (name: string, args: Record<string, unknown>, callId: string) => {
    activity.observeToolBatch({ text: "", toolCalls: [{ name, args }] });
    return activity.observeTool({ name, effectiveToolName: name, args, callId });
  };
  try {
    const review = await observe("record_work_review", { subject: "plan", verdict: "accept", summary: "Official sources first",
      action_updates: [{ action_key: "research", status: "active" }] }, "review");
    await activity.publishAccepted(review);
    const search = await observe("web_search", { query: "public guidance" }, "search");
    await progress.operationChanged?.({ turnId: "turn-json", semanticState: "admitted", activityId: search.activityId,
      requestId: "search", publicTitle: "Search", capabilityRef: "web_search", status: "started" });
    const checkpoint = await observe("record_work_checkpoint", { public_summary: "Sources compared", next_step: "Read guidance",
      action_updates: [{ action_key: "synthesize", status: "active" }] }, "checkpoint");
    await activity.publishAccepted(checkpoint);
    const read = await observe("web_read", { url: "https://example.com" }, "read");
    await progress.operationChanged?.({ turnId: "turn-json", semanticState: "admitted", activityId: read.activityId,
      requestId: "read", publicTitle: "Read", capabilityRef: "web_read", status: "started" });

    expect(failures).toEqual([]);
    const events = repository.forTurn("turn-json");
    const notes = events.filter(item => item.event.kind === "assistant.public_note");
    expect(notes.map(item => item.event.payload?.activityStage)).toEqual(["review", "execution", "execution"]);
    expect(notes[1]?.event.payload?.decisionTitle).toBe("research");
    expect(notes[2]?.event.payload?.decisionTitle).toBe("synthesize");
    expect(search.activityId).not.toBe(review.activityId);
    expect(read.activityId).toBe(checkpoint.activityId);
    const rows = projectStewardActivityRows({ session_id: "steward-json", title: "Research", messages: [], plan: null, result: null,
      turns: [{ id: "turn-json", state: "admitted", created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:01:00Z" }],
      updated_at: "2026-09-08T00:01:00Z",
      progress_events: events.map(item => ({ id: item.eventId, session_id: item.sessionId, turn_id: item.turnId,
        session_sequence: item.sessionSequence, turn_sequence: item.turnSequence, kind: item.event.kind,
        payload: item.event.payload ?? {}, visibility: "public" as const, created_at: item.event.createdAt! })),
    });
    const projected = projectTurnActivity(rows);
    expect(projected.phaseActivities.map(item => item.title)).toEqual(["Review plan", "research", "synthesize"]);
    expect(projected.phaseActivities[1]?.operations.map(item => item.tool_call_id)).toEqual(["search"]);
    expect(projected.phaseActivities[2]?.operations.map(item => item.tool_call_id)).toEqual(["read"]);
  } finally {
    db.close();
  }
});
