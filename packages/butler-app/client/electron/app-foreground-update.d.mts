export function quitAndInstallAppUpdate<TSnapshot>(input: {
  readActiveWork: () => Promise<TSnapshot>;
  confirmQuit: (snapshot: TSnapshot) => Promise<boolean>;
  stopForUpdate: (snapshot: TSnapshot) => Promise<void>;
  quitAndInstall: () => void;
}): Promise<Record<string, unknown>>;
