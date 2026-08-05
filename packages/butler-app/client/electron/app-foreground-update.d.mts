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
