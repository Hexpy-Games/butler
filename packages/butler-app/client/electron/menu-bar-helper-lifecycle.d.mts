export declare const MENU_BAR_HELPER_ARG = "--butler-menu-bar-helper";
export declare const QUIT_MAIN_UI_ARG = "--butler-quit-main-ui";
export declare const QUIT_MENU_BAR_HELPER_ARG = "--butler-quit-menu-bar-helper";
export declare const NEW_CHAT_ARG = "--butler-new-chat";
export declare const OPEN_SESSION_ARG_PREFIX = "--butler-open-session=";

export interface ProcessModeInput {
  argv?: string[];
  env?: Record<string, string | undefined>;
}

export interface PersistentMenuBarHelperInput {
  platform?: string;
  isPackaged?: boolean;
  env?: Record<string, string | undefined>;
}

export interface TrayOwnershipInput {
  trayEnabled?: boolean;
  helperMode?: boolean;
  persistentHelperSupported?: boolean;
}

export interface PersistentMenuBarHelperLaunchInput {
  trayEnabled?: boolean;
  persistentHelperSupported?: boolean;
  launchAttempted?: boolean;
}

export type HelperLifecycleAction =
  | "close-window"
  | "quit-main-ui"
  | "quit-helper"
  | "stop-agent";

export interface HelperLifecycleEffect {
  quitsMainUi: boolean;
  quitsHelper: boolean;
  stopsAgent: boolean;
}

export type NativeNavigationRequest =
  | { action: "new-chat" }
  | { action: "open-session"; sessionId: string };

export declare function hasArg(argv: string[] | undefined, flag: string): boolean;
export declare function isMenuBarHelperMode(input?: ProcessModeInput): boolean;
export declare function isQuitMainUiSignalMode(input?: ProcessModeInput): boolean;
export declare function isQuitMenuBarHelperSignalMode(input?: ProcessModeInput): boolean;
export declare function persistentMenuBarHelperSupported(
  input?: PersistentMenuBarHelperInput,
): boolean;
export declare function shouldLaunchPersistentMenuBarHelper(
  input?: PersistentMenuBarHelperLaunchInput,
): boolean;
export declare function mainProcessOwnsTray(input?: TrayOwnershipInput): boolean;
export declare function helperProcessOwnsTray(input?: TrayOwnershipInput): boolean;
export declare function helperLifecycleAction(
  action: HelperLifecycleAction,
): HelperLifecycleEffect;
export declare function navigationRequestFromArgs(
  argv?: string[],
): NativeNavigationRequest | null;
export declare function argsForNavigationRequest(
  request?: Partial<NativeNavigationRequest>,
): string[];
