import type { Database } from "bun:sqlite";
import type {
  BtccRuntimeDependencies,
} from "../../../btcc/index.ts";
import { stableJson } from "./identity.ts";

type PhaseConversationStore = BtccRuntimeDependencies["phaseConversations"];
type PhaseRunBinding = Parameters<PhaseConversationStore["loadAcceptedProduct"]>[0];
type PersistInput = Parameters<PhaseConversationStore["persistAcceptedProduct"]>[0];
type ActualModelIdentity = PersistInput["actualIdentity"];

type ProductRow = {
  accepted_product_json: string | null;
  actual_identity_json: string | null;
  active_claim_id: string | null;
  is_active: number;
};

export class SqlitePhaseConversationStore implements PhaseConversationStore {
  constructor(private readonly db: Database) {}

  async loadAcceptedProduct<Product>(binding: PhaseRunBinding): Promise<Product | null> {
    const row = this.loadCheckpoint(binding);
    if (!row.accepted_product_json) return null;
    return JSON.parse(row.accepted_product_json) as Product;
  }

  async persistAcceptedProduct<Product>(input: {
    binding: PhaseRunBinding;
    product: Product;
    actualIdentity: ActualModelIdentity;
  }): Promise<void> {
    const productJson = stableJson(input.product);
    const identityJson = stableJson(input.actualIdentity);
    const transaction = this.db.transaction(() => {
      const row = this.loadCheckpoint(input.binding);
      if (row.accepted_product_json) {
        if (
          row.accepted_product_json !== productJson ||
          row.actual_identity_json !== identityJson
        ) {
          throw new Error("BTCC checkpoint product identity conflict");
        }
        return;
      }
      this.db.query(`
        UPDATE btcc_checkpoints
        SET accepted_product_json = ?, actual_identity_json = ?
        WHERE checkpoint_id = ? AND checkpoint_revision = ? AND active_claim_id = ?
      `).run(
        productJson,
        identityJson,
        input.binding.checkpointId,
        input.binding.checkpointRevision,
        input.binding.claimId,
      );
    });
    transaction();
  }

  private loadCheckpoint(binding: PhaseRunBinding): ProductRow {
    const row = this.db.query<ProductRow, [string, number]>(`
      SELECT accepted_product_json, actual_identity_json, active_claim_id, is_active
      FROM btcc_checkpoints
      WHERE checkpoint_id = ? AND checkpoint_revision = ?
    `).get(binding.checkpointId, binding.checkpointRevision);
    const claim = this.db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_state_claims WHERE claim_id = ?
    `).get(binding.claimId);
    if (
      !row ||
      row.is_active !== 1 ||
      row.active_claim_id !== binding.claimId ||
      claim?.status !== "active"
    ) {
      throw new Error("BTCC phase checkpoint is not owned by the exact active claim");
    }
    return row;
  }
}
