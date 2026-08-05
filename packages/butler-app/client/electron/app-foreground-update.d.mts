export type AppForegroundUpdateStopPlan = {
  allowed: boolean;
  requiresDrain: boolean;
  restoreState: string | null;
  reason: string | null;
};

export function planAppForegroundUpdateStop(input?: {
  usesAppForegroundLifecycle?: boolean;
  foregroundState?: string | null;
  activeWorkSnapshot?: { classification?: string } | null;
  restoreState?: string | null;
}): AppForegroundUpdateStopPlan;

export type AppForegroundUpdateStopResult =
  | {
      update_ready: true;
      drain?: Record<string, unknown> | null;
    }
  | {
      update_ready: false;
      drain?: Record<string, unknown> | null;
      raw_text_included?: false;
    };

export function quitAndInstallAppUpdate<TSnapshot>(input: {
  readActiveWork: () => Promise<TSnapshot>;
  confirmQuit: (snapshot: TSnapshot) => Promise<boolean>;
  stopForUpdate: (
    snapshot: TSnapshot,
  ) => Promise<AppForegroundUpdateStopResult | void>;
  quitAndInstall: () => void;
}): Promise<Record<string, unknown>>;
