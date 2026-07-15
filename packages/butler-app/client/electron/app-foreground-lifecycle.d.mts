export interface AppForegroundInstanceRecord {
  schema: "butler.app-foreground-instance.v1";
  generation: string;
  state: string;
  app_pid: number;
  agent_host_pid: number | null;
  process_group_id: number | null;
  platform: string | null;
  architecture: string | null;
  containment_kind: string | null;
  containment_verified: boolean;
  owner_death_guaranteed: boolean;
  launch_nonce_hash: string;
  app_version: string | null;
  bundled_agent_version: string | null;
  gateway_profile: string;
  host: string;
  port: number | null;
  started_at: string;
  updated_at: string;
  clean_exit: boolean;
  raw_text_included: false;
}

export function appForegroundStartupFailurePath(butlerData: string): string;
export function appForegroundStartupProgressPath(butlerData: string): string;
export function clearAppForegroundStartupFailure(butlerData: string): void;
export function writeAppForegroundStartupFailure(
  butlerData: string,
  input: {
    platform?: string;
    architecture?: string;
    lifecycleMode?: string;
    supervisorPhase?: string;
    errorCode?: string | null;
    exitCode?: number | null;
    signal?: string | null;
    containmentKind?: string | null;
    containmentVerified?: boolean;
    ownerDeathGuaranteed?: boolean;
  },
  now?: () => Date,
): Record<string, unknown>;
export function writeAppForegroundStartupProgress(
  butlerData: string,
  input: {
    stage: string;
    platform?: string;
    architecture?: string;
    lifecycleMode?: string;
    agentPhase?: string | null;
    containmentKind?: string | null;
    trayReady?: boolean;
    windowReady?: boolean;
  },
  now?: () => Date,
): Record<string, unknown>;

export const APP_FOREGROUND_INSTANCE_SCHEMA: string;
export const APP_FOREGROUND_LAST_EXIT_SCHEMA: string;
export const APP_FOREGROUND_MIGRATION_SCHEMA: string;
export const APP_FOREGROUND_PHASES: readonly string[];
export const APP_FOREGROUND_LIFECYCLE_MODES: Readonly<{
  foreground: "app-foreground";
  nativeService: "native-service";
}>;
export function appForegroundRuntimeDir(butlerData: string): string;
export function appForegroundInstancePath(butlerData: string): string;
export function appForegroundLastExitPath(butlerData: string): string;
export function appForegroundMigrationPath(butlerData: string): string;
export function resolveAppLifecycleMode(input?: Record<string, unknown>): string;
export function createAppForegroundLaunch(input?: Record<string, unknown>): {
  nonce: string;
  record: AppForegroundInstanceRecord;
};
export function transitionAppForeground(
  record: AppForegroundInstanceRecord,
  nextState: string,
  options?: Record<string, unknown>,
): AppForegroundInstanceRecord;
export function writeAppForegroundInstance(
  butlerData: string,
  record: AppForegroundInstanceRecord,
): AppForegroundInstanceRecord;
export function readAppForegroundInstance(butlerData: string): AppForegroundInstanceRecord | null;
export function writeAppForegroundLastExit(
  butlerData: string,
  input: Record<string, unknown>,
  now?: () => Date,
): Record<string, unknown>;
export function writeAppForegroundMigration(
  butlerData: string,
  input: Record<string, unknown>,
  now?: () => Date,
): Record<string, unknown>;
export function createRecoveryBudget(input?: { maxAttempts?: number; windowMs?: number }): {
  record(nowMs?: number): boolean;
  remaining(nowMs?: number): number;
};
