import type { Database } from "bun:sqlite";
import type {
  BtccWakeAuthorization,
  BtccWakeAuthorizationReader,
} from "../../../btcc/turn/index.ts";

export interface BtccWakeAuthorizationRepository extends BtccWakeAuthorizationReader {
  recordAuthorization(input: BtccWakeAuthorization): void;
}

export class SqliteBtccWakeAuthorizationRepository
  implements BtccWakeAuthorizationRepository {
  constructor(private readonly db: Database) {}

  validateWake(input: BtccWakeAuthorization): boolean {
    if (!input.sourceTurnId.trim() || !input.authorizationRef.trim()) return false;
    return Boolean(this.db.query<{ source_turn_id: string }, [string, string, string]>(`
      SELECT source_turn_id
      FROM btcc_wake_authorizations
      WHERE source_turn_id = ?
        AND authorization_ref = ?
        AND result_scope_ref = ?
      LIMIT 1
    `).get(
      input.sourceTurnId,
      input.authorizationRef,
      input.resultScopeRef ?? "",
    ));
  }

  recordAuthorization(input: BtccWakeAuthorization): void {
    if (!input.sourceTurnId.trim() || !input.authorizationRef.trim()) {
      throw new Error("BTCC wake authorization facts require source and authorization refs");
    }
    this.db.query(`
      INSERT OR IGNORE INTO btcc_wake_authorizations (
        source_turn_id, authorization_ref, result_scope_ref, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      input.sourceTurnId,
      input.authorizationRef,
      input.resultScopeRef ?? "",
      new Date().toISOString(),
    );
  }
}
