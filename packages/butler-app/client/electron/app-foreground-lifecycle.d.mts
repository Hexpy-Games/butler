export interface AppForegroundInstanceRecord {
  schema: "butler.app-foreground-instance.v1";
  generation: string;
  state: string;
  app_pid: number;
  agent_host_pid: number | null;
  process_group_id: number | null;
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
