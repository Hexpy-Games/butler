export const WINDOWS_SQUIRREL_PACKAGE_ID: "butler-app";
export const WINDOWS_SQUIRREL_EXE_NAME: "Butler.exe";
export const WINDOWS_APP_USER_MODEL_ID: "com.squirrel.butler-app.Butler";
export const WINDOWS_APP_PROTOCOL: "butler";
export const WINDOWS_SQUIRREL_FIRST_RUN_UPDATE_DELAY_MS: 10000;

export interface WindowsSquirrelLaunch {
  handled: boolean;
  firstRun: boolean;
  event: string | null;
  shortcutAction?: "create" | "remove" | null;
  stubLauncher?: string;
  shortcutName?: string;
  shortcutWorkingDirectory?: string;
  appUserModelId?: string;
  protocol?: string;
  removeOperationalState?: boolean;
  registerProtocol?: boolean;
  unregisterProtocol?: boolean;
  rawTextIncluded: false;
}

export function resolveWindowsSquirrelLaunch(input?: {
  platform?: string;
  argv?: string[];
  execPath?: string;
}): WindowsSquirrelLaunch;

export function windowsLoginItemSettings(input?: {
  openAtLogin?: boolean;
  platform?: string;
  isPackaged?: boolean;
  execPath?: string;
}): {
  openAtLogin: boolean;
  openAsHidden?: boolean;
  path?: string;
  args?: string[];
  name?: string;
};

export function windowsOperationalCleanupPaths(butlerData: string): string[];

export function removeWindowsOperationalState(input: {
  butlerData: string;
  removePath?: (path: string) => void;
}): string[];

export function executeWindowsSquirrelLaunch(
  plan: WindowsSquirrelLaunch,
  adapters?: {
    manageShortcut?: (input: {
      action: "create" | "remove";
      name: string;
      target: string;
      workingDirectory: string;
    }) => boolean;
    setLoginItemSettings?: (settings: unknown) => void;
    registerProtocol?: (scheme: string, executable: string, args: string[]) => boolean;
    unregisterProtocol?: (scheme: string, executable: string, args: string[]) => boolean;
    cleanupOperationalState?: () => string[];
  },
): {
  handled: boolean;
  event: string | null;
  shortcutAction?: "create" | "remove" | null;
  operationalStateRemoved?: boolean;
};

export function manageWindowsSquirrelShortcut(input: {
  action: "create" | "remove";
  name: string;
  target: string;
  workingDirectory: string;
  runPowerShell: (
    command: string,
    args: string[],
    options: {
      env: Record<string, string | undefined>;
      [key: string]: unknown;
    },
  ) => { status?: number | null };
  env?: Record<string, string | undefined>;
}): true;

export function resolveWindowsUpdateFeedUrl(input?: {
  platform?: string;
  isPackaged?: boolean;
  env?: Record<string, string | undefined>;
}): string | null;

export function shouldDelayWindowsFirstUpdateCheck(input?: {
  platform?: string;
  argv?: string[];
}): boolean;

export function verifyWindowsInstallerPublisher(input: {
  currentExecutable: string;
  candidateInstaller: string;
  runPowerShell: (
    command: string,
    args: string[],
    options: {
      env: Record<string, string | undefined>;
      [key: string]: unknown;
    },
  ) => { status?: number | null; stdout?: string };
  env?: Record<string, string | undefined>;
}): {
  status: "Valid";
  signerThumbprint: string;
  signerSubject: string;
  publisherConsistent: true;
  rawTextIncluded: false;
};
