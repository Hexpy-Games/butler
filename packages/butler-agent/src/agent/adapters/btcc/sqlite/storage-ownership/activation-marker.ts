import { Database } from "bun:sqlite";
import type {
  AgentBtccActivationMarker,
  AgentBtccMigrationReceipt,
} from "./contracts.ts";
import { agentBtccStoragePaths, readValidatedReceipt } from "./agent-storage-migration.ts";

export function activateAgentBtccStorage(input: {
  butlerData: string;
  runtimeVersion: string;
  now?: () => Date;
}): AgentBtccActivationMarker {
  const paths = agentBtccStoragePaths(input.butlerData);
  const receipt = readValidatedReceipt(paths.agentBtccDbPath);
  const db = new Database(paths.agentBtccDbPath, { strict: true });
  try {
    const existing = readActivationMarker(db);
    if (existing) {
      validateMarker(existing, receipt);
      return existing;
    }
    const activatedAt = (input.now?.() ?? new Date()).toISOString();
    const marker: AgentBtccActivationMarker = {
      schema: "butler.agent-btcc-storage-activation.v1",
      manifestId: receipt.manifestId,
      storageContract: "split-v1",
      runtimeVersion: input.runtimeVersion,
      firstActivatedAt: activatedAt,
      activatedAt,
    };
    db.query(`
      INSERT INTO agent_storage_activation_marker
        (singleton, manifest_id, marker_json) VALUES (1, ?, ?)
    `).run(marker.manifestId, JSON.stringify(marker));
    return marker;
  } finally {
    db.close();
  }
}

export function validateAgentBtccStorageForReadiness(input: {
  butlerData: string;
  storageContract?: "split-v1";
}): AgentBtccActivationMarker {
  const paths = agentBtccStoragePaths(input.butlerData);
  const receipt = readValidatedReceipt(paths.agentBtccDbPath);
  const db = new Database(paths.agentBtccDbPath, { readonly: true, strict: true });
  try {
    const marker = readActivationMarker(db);
    if (!marker) throw new Error("agent_btcc_storage_activation_missing");
    validateMarker(marker, receipt, input.storageContract ?? "split-v1");
    return marker;
  } finally {
    db.close();
  }
}

function readActivationMarker(db: Database): AgentBtccActivationMarker | null {
  const row = db.query<{ marker_json: string }, []>(`
    SELECT marker_json FROM agent_storage_activation_marker WHERE singleton = 1
  `).get();
  return row ? JSON.parse(row.marker_json) as AgentBtccActivationMarker : null;
}

function validateMarker(
  marker: AgentBtccActivationMarker,
  receipt: AgentBtccMigrationReceipt,
  storageContract: "split-v1" = "split-v1",
): void {
  if (marker.schema !== "butler.agent-btcc-storage-activation.v1" ||
    marker.manifestId !== receipt.manifestId || marker.storageContract !== storageContract ||
    !marker.firstActivatedAt || !marker.activatedAt) {
    throw new Error("agent_btcc_storage_activation_invalid");
  }
}
