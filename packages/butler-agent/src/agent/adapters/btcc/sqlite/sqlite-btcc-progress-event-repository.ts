import type { Database } from "bun:sqlite";
import type {
  BtccCommittedProgressEvent,
  BtccProgressDestination,
  BtccProgressEventRepository,
} from "../../../btcc/index.ts";
import type { RuntimeTurnEventInput } from "../../../events/turn-events.ts";
import { digest, stableJson } from "./identity.ts";

type ProgressEventRow = {
  event_id: string;
  action_id: string;
  session_id: string;
  turn_id: string;
  session_sequence: number;
  turn_sequence: number;
  event_fingerprint: string;
  event_json: string;
  destination_json: string;
  status: string;
};

export class SqliteBtccProgressEventRepository implements BtccProgressEventRepository {
  constructor(private readonly db: Database) {}

  append(input: Parameters<BtccProgressEventRepository["append"]>[0]): BtccCommittedProgressEvent {
    const event = canonicalEvent(input.event);
    const eventFingerprint = digest(stableJson({
      kind: event.kind,
      visibility: event.visibility,
      payload: event.payload ?? {},
    }));
    const destinationJson = stableJson(input.destination);
    const eventId = `btcc-progress-event:${digest(
      `btcc-progress-event.v1\0${input.turnId}\0${eventFingerprint}`,
    )}`;
    const actionId = `btcc-progress-action:${digest(stableJson({
      version: 1,
      eventId,
      destination: input.destination,
    }))}`;
    const row = this.db.transaction(() => {
      const existing = this.db.query<ProgressEventRow, [string, string]>(`
        SELECT event_id, action_id, session_id, turn_id, session_sequence,
          turn_sequence, event_fingerprint, event_json, destination_json, status
        FROM btcc_progress_events
        WHERE turn_id = ? AND event_fingerprint = ?
      `).get(input.turnId, eventFingerprint);
      if (existing) return existing;

      const sessionSequence = this.db.query<{ next_sequence: number }, [string]>(`
        SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next_sequence
        FROM btcc_progress_events WHERE session_id = ?
      `).get(input.sessionId)?.next_sequence ?? 1;
      const turnSequence = this.db.query<{ next_sequence: number }, [string]>(`
        SELECT COALESCE(MAX(turn_sequence), 0) + 1 AS next_sequence
        FROM btcc_progress_events WHERE turn_id = ?
      `).get(input.turnId)?.next_sequence ?? 1;
      this.db.query(`
        INSERT INTO btcc_progress_events (
          event_id, action_id, session_id, turn_id, session_sequence,
          turn_sequence, event_fingerprint, event_json, destination_json,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        eventId,
        actionId,
        input.sessionId,
        input.turnId,
        sessionSequence,
        turnSequence,
        eventFingerprint,
        stableJson(event),
        destinationJson,
        new Date().toISOString(),
      );
      const inserted = this.db.query<ProgressEventRow, [string]>(`
        SELECT event_id, action_id, session_id, turn_id, session_sequence,
          turn_sequence, event_fingerprint, event_json, destination_json, status
        FROM btcc_progress_events WHERE event_id = ?
      `).get(eventId);
      if (!inserted) throw new Error("BTCC progress event was not persisted");
      return inserted;
    }).immediate() as ProgressEventRow;
    return hydrateProgressEvent(row);
  }

  pending(turnId?: string): BtccCommittedProgressEvent[] {
    if (turnId) return this.forTurn(turnId).filter((event) => event.status === "pending");
    return this.db.query<ProgressEventRow, []>(`
      SELECT event_id, action_id, session_id, turn_id, session_sequence,
        turn_sequence, event_fingerprint, event_json, destination_json, status
      FROM btcc_progress_events
      WHERE status = 'pending'
      ORDER BY session_sequence ASC, event_id ASC
    `).all().map(hydrateProgressEvent);
  }

  forTurn(turnId: string): BtccCommittedProgressEvent[] {
    return this.db.query<ProgressEventRow, [string]>(`
      SELECT event_id, action_id, session_id, turn_id, session_sequence,
        turn_sequence, event_fingerprint, event_json, destination_json, status
      FROM btcc_progress_events
      WHERE turn_id = ?
      ORDER BY turn_sequence ASC, event_id ASC
    `).all(turnId).map(hydrateProgressEvent);
  }

  markPublished(eventId: string): void {
    this.db.query(`
      UPDATE btcc_progress_events SET status = 'published'
      WHERE event_id = ? AND status = 'pending'
    `).run(eventId);
  }
}

function canonicalEvent(input: RuntimeTurnEventInput): RuntimeTurnEventInput {
  return {
    ...input,
    visibility: input.visibility ?? "public",
  };
}

function hydrateProgressEvent(row: ProgressEventRow): BtccCommittedProgressEvent {
  if (row.status !== "pending" && row.status !== "published") {
    throw new Error(`BTCC progress event status is invalid: ${row.status}`);
  }
  return {
    eventId: row.event_id,
    actionId: row.action_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    sessionSequence: row.session_sequence,
    turnSequence: row.turn_sequence,
    event: JSON.parse(row.event_json) as RuntimeTurnEventInput,
    destination: JSON.parse(row.destination_json) as BtccProgressDestination,
    status: row.status,
  };
}
