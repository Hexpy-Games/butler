import { Database } from "bun:sqlite";
import {
  FIRST_VISIBLE_PROGRESS_EVENT_KIND,
} from "../../../../agent/events/turn-events.ts";
import { TURN_ACKNOWLEDGED_EVENT_KIND } from "../../../../agent/events/turn-state-contract.ts";
import type { TurnRow } from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { isTerminalTurnState, turnFromRow } from "./message-read-model.ts";
import type { TurnRecord, TurnState } from "../../interface/protocol/app-protocol.ts";

export class AppTurnRecordStore {
  constructor(
    private readonly db: Database,
    private readonly hasTurnEventKind: (turnId: string, kind: string) => boolean,
  ) {}

  insertTurn(
    chatId: string,
    state: TurnState,
    safeStatusLabel: string,
  ): TurnRecord {
    const id = `turn-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO turns (
        id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?, NULL, 0, 0, 1, ?, ?)
    `,
      )
      .run(id, chatId, state, safeStatusLabel, createdAt, createdAt);
    return this.getTurn(id);
  }

  setTurnUserMessage(turnId: string, messageId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        "UPDATE turns SET user_message_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(messageId, now, turnId);
  }

  updateTurnState(
    turnId: string,
    state: TurnState,
    options: {
      safeStatusLabel: string;
      safeErrorCode?: string | null;
      retryable?: boolean;
      cancellable?: boolean;
      attempt?: number;
    },
  ): TurnRecord {
    const current = this.getTurnRow(turnId);
    if (!current) {
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    }
    if (current.state === "cancelled" && state !== "cancelled") {
      return this.getTurn(turnId);
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE turns
      SET state = ?, safe_status_label = ?, safe_error_code = ?, retryable = ?,
        cancellable = ?, attempt = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        state,
        options.safeStatusLabel,
        options.safeErrorCode ?? null,
        (options.retryable ?? false) ? 1 : 0,
        (options.cancellable ?? false) ? 1 : 0,
        options.attempt ?? current.attempt,
        now,
        turnId,
      );
    return this.getTurn(turnId);
  }

  claimRetryTurn(turnId: string, attempt: number): TurnRecord {
    const now = new Date().toISOString();
    const result = this.db
      .query(
        `
      UPDATE turns
      SET state = 'retrying', safe_status_label = 'Retrying', safe_error_code = NULL,
        retryable = 0, cancellable = 1, attempt = ?, updated_at = ?
      WHERE id = ? AND state = 'runtime_fault' AND retryable = 1
    `,
      )
      .run(attempt, now, turnId) as { changes: number };
    if (result.changes !== 1) {
      throw new AppStoreOperationError(
        409,
        "turn_not_retryable",
        "Turn is not retryable.",
      );
    }
    return this.getTurn(turnId);
  }

  getTurn(turnId: string): TurnRecord {
    const row = this.getTurnRow(turnId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    }
    return turnFromRow(row);
  }

  getTurnRow(turnId: string): TurnRow | null {
    return (
      this.db
        .query<TurnRow, [string]>(
          `
      SELECT rowid, id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, created_at, updated_at
      FROM turns
      WHERE id = ?
    `,
        )
        .get(turnId) ?? null
    );
  }

  turnExists(turnId: string): boolean {
    return Boolean(this.getTurnRow(turnId));
  }

  isTerminalTurn(turnId: string): boolean {
    const turn = this.getTurnRow(turnId);
    return Boolean(turn && isTerminalTurnState(turn.state));
  }

  shouldPersistRuntimeTurnEvent(turnId: string, kind: string): boolean {
    if (
      (kind === TURN_ACKNOWLEDGED_EVENT_KIND ||
        kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) &&
      this.hasTurnEventKind(turnId, kind)
    ) {
      return false;
    }
    const turn = this.getTurnRow(turnId);
    if (!turn || !isTerminalTurnState(turn.state)) return true;
    if (turn.state === "cancelled") return kind === "turn.cancelled";
    if (turn.state === "failed") return kind === "turn.failed";
    if (turn.state === "runtime_fault") return kind === "runtime.fault";
    if (turn.state === "delivered") return kind === "turn.completed";
    return false;
  }
}
