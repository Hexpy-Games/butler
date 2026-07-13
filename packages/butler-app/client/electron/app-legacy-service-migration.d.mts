export type LegacyServiceInspection = {
  required: boolean;
  plists: string[];
  pidFiles: string[];
  serviceStates: Array<{ path: string; processGroupId: number }>;
  detectedArtifacts: string[];
};

export type LegacyServiceMigrationRecord = {
  status: "complete" | "cancelled" | "failed";
  detected_artifacts: string[];
  [key: string]: unknown;
};

export const LEGACY_APP_SERVICE_LABELS: readonly string[];

export function inspectLegacyAppService(options: {
  butlerData: string;
  homeDir?: string;
  exists?: (path: string) => boolean;
  readJson?: (path: string) => unknown;
}): LegacyServiceInspection;

export function migrateLegacyAppService(options: {
  butlerData: string;
  homeDir?: string;
  uid?: number;
  inspect?: () => LegacyServiceInspection;
  activeWorkSnapshot?: () => Promise<{ classification: string }>;
  confirm?: (snapshot: { classification: string }) => Promise<boolean>;
  runCommand?: (command: string, args: string[]) => Promise<void>;
  killProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  isProcessRunning?: (processGroupId: number) => boolean;
  waitForProcessExit?: (
    processGroupId: number,
    isRunning: (processGroupId: number) => boolean,
  ) => Promise<void>;
  remove?: (path: string) => void;
  now?: () => Date;
}): Promise<LegacyServiceMigrationRecord>;
