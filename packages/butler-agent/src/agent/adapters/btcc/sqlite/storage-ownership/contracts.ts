export type AgentBtccStoragePaths = {
  legacyAppDbPath: string;
  agentBtccDbPath: string;
  temporaryAgentBtccDbPath: string;
};

export type LegacyWriterFenceReceipt = {
  fenceId: string;
  reconciledClaims: number;
  parkedClaims: number;
};

export type AgentBtccMigrationTableReceipt = {
  name: string;
  rowCount: number;
  contentSha256: string;
};

export type AgentBtccMigrationReceipt = {
  schema: "butler.agent-btcc-storage-migration.v1";
  manifestId: string;
  sourceKind: "legacy_app_db" | "fresh_install";
  sourceSchemaVersion: number;
  sourceSizeBytes: number;
  fence: LegacyWriterFenceReceipt;
  tables: AgentBtccMigrationTableReceipt[];
  completedAt: string;
};

export type AgentBtccActivationMarker = {
  schema: "butler.agent-btcc-storage-activation.v1";
  manifestId: string;
  storageContract: "split-v1";
  runtimeVersion: string;
  firstActivatedAt: string;
  activatedAt: string;
};

export type PrepareAgentBtccStorageResult = {
  kind: "migrated" | "fresh" | "existing";
  receipt: AgentBtccMigrationReceipt;
};
