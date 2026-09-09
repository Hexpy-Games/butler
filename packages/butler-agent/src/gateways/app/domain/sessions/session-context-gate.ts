import type { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

type Owner = { owner_kind: "turn" | "relocate"; owner_id: string };

/** One durable owner for the session's execution context, shared by admission and relocation. */
export class AppSessionContextGate {
  constructor(private readonly db: Database) {}

  owner(sessionId: string): Owner | null {
    return this.db.query<Owner, [string]>("SELECT owner_kind,owner_id FROM app_session_context_gate WHERE session_id=?").get(sessionId);
  }

  assertNotRelocating(sessionId: string): void {
    if (this.owner(sessionId)?.owner_kind === "relocate") {
      throw new AppStoreOperationError(409, "session_relocating", "대화를 이동하고 있습니다. 잠시 후 다시 보내 주세요.");
    }
  }

  claimTurn(sessionId: string, turnId: string): void {
    this.assertNotRelocating(sessionId);
    const owner = this.owner(sessionId);
    if (owner?.owner_kind === "turn" && owner.owner_id !== turnId) {
      const active = this.db.query<{ id: string }, [string]>(`SELECT id FROM turns WHERE id=?
        AND state NOT IN ('delivered','cancelled','failed','runtime_fault')`).get(owner.owner_id);
      if (active) throw new AppStoreOperationError(409, "session_busy", "이 대화에서 앞선 작업이 진행 중입니다.");
    }
    this.db.query(`INSERT INTO app_session_context_gate VALUES(?,'turn',?)
      ON CONFLICT(session_id) DO UPDATE SET owner_id=excluded.owner_id
      WHERE app_session_context_gate.owner_kind='turn'`).run(sessionId, turnId);
  }

  claimRelocation(sessionId: string, operationId: string, hasOpenChild: boolean): void {
    this.assertNotRelocating(sessionId);
    const active = this.db.query<{ id: string }, [string]>(`SELECT id FROM turns WHERE chat_id=?
      AND (state NOT IN ('delivered','cancelled','failed','runtime_fault') OR retryable=1) LIMIT 1`).get(sessionId);
    const queued = this.db.query<{ id: string }, [string]>(`SELECT id FROM session_queued_messages
      WHERE chat_id=? AND state IN ('queued','dispatching') LIMIT 1`).get(sessionId);
    if (active || queued || hasOpenChild) {
      throw new AppStoreOperationError(409, "session_busy", "진행 중인 작업과 대기 메시지가 끝난 뒤 이동할 수 있습니다.");
    }
    this.db.query("DELETE FROM app_session_context_gate WHERE session_id=? AND owner_kind='turn'").run(sessionId);
    this.db.query("INSERT INTO app_session_context_gate VALUES(?,'relocate',?)").run(sessionId, operationId);
  }

  releaseRelocation(sessionId: string, operationId: string): void {
    this.db.query("DELETE FROM app_session_context_gate WHERE session_id=? AND owner_kind='relocate' AND owner_id=?").run(sessionId, operationId);
  }
}
