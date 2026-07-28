import type { Database } from "bun:sqlite";
import type {
  ActualModelIdentity,
  PhaseRunBinding,
} from "../../../../btcc/gateway-api.ts";
import { digest, stableJson } from "../identity.ts";

export class PhaseModelRoundLog {
  constructor(private readonly db: Database) {}

  append(
    binding: PhaseRunBinding,
    checkpointRevision: number,
    round: { kind: string; actualIdentity: ActualModelIdentity },
  ): void {
    const previous = this.db.query<{ ordinal: number }, [string]>(`
      SELECT COALESCE(MAX(round_ordinal), 0) AS ordinal
      FROM btcc_phase_model_rounds WHERE checkpoint_id = ?
    `).get(binding.checkpointId);
    const ordinal = (previous?.ordinal ?? 0) + 1;
    this.db.query(`
      INSERT INTO btcc_phase_model_rounds (
        round_id, checkpoint_id, checkpoint_revision, round_ordinal,
        carrier_kind, actual_identity_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      digest(
        `btcc-phase-model-round.v1\0${binding.checkpointId}\0${checkpointRevision}`,
      ),
      binding.checkpointId,
      checkpointRevision,
      ordinal,
      round.kind,
      stableJson(round.actualIdentity),
    );
  }
}
