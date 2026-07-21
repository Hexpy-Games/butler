import type { Database } from "bun:sqlite";
import type {
  BtccPersistenceTypes,
  LearningSourceScheduler,
} from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";

export class SqliteLearningSourceScheduler implements LearningSourceScheduler {
  constructor(private readonly db: Database) {}

  schedule(turn: TurnRecord): void {
    queueMicrotask(() => {
      try {
        this.project(turn);
      } catch {
        // Delivery is authoritative. A later projection scan reconciles this gap.
      }
    });
  }

  private project(turn: TurnRecord): void {
    if (turn.semanticState !== "delivered" || !turn.finalPayload) return;
    const finalPayload = turn.finalPayload;
    const sourceId = digest(
      `btcc-learning-source.v1\0${turn.turnId}\0${finalPayload.ref.sha256}`,
    );
    const source = {
      sourceId,
      turnId: turn.turnId,
      finalPayloadRef: finalPayload.ref,
      goalContractRef: turn.managed?.goalAcceptance?.goalContract.ref,
      finalDossierRef: turn.managed?.finalDossier?.dossier.ref,
      reviewReceiptRefs: turn.managed?.program?.planningState === "reviewed"
        ? turn.managed.program.tasks.flatMap((task) =>
            task.currentReview ? [task.currentReview.review.ref] : [])
        : [],
      recentFeedbackRefs: turn.context.recentFeedbackRefs,
    };
    this.db.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO btcc_learning_sources (
          source_id, turn_id, final_payload_ref, source_json
        ) VALUES (?, ?, ?, ?)
      `).run(sourceId, turn.turnId, stableJson(finalPayload.ref), stableJson(source));
      this.db.query(`
        INSERT OR IGNORE INTO btcc_learning_candidate_outbox (
          outbox_id, source_id, status
        ) VALUES (?, ?, 'pending')
      `).run(digest(`btcc-learning-outbox.v1\0${sourceId}`), sourceId);
    })();
  }
}

type TurnRecord = BtccPersistenceTypes["turn"];
