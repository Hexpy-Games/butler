export type SessionFolderLaunchTarget = "vscode" | "terminal" | "fileManager";

export interface SessionFolderLaunchSpec {
  command: string;
  args: string[];
  application?: string;
  options?: { cwd?: string };
}

export type SessionFolderLaunchTargetsResult =
  | { ok: true; targets: SessionFolderLaunchTarget[] }
  | {
      ok: false;
      code: "session_workspace_unavailable";
      recoverable: true;
      targets: [];
    };

export type SessionFolderLaunchResult =
  | { ok: true; target: SessionFolderLaunchTarget }
  | {
      ok: false;
      code:
        | "session_workspace_unavailable"
        | "launch_target_unavailable"
        | "session_folder_launch_failed";
      recoverable: true;
    };

export interface SessionFolderLauncherOptions {
  platform?: string;
  resolveWorkspacePath?: (
    sessionId: string,
  ) => string | null | Promise<string | null>;
  isDirectory?: (workspacePath: string) => boolean | Promise<boolean>;
  isApplicationAvailable?: (application: string) => boolean;
  resolveCommand?: (command: string) => string | null;
  launchApplication?: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => { ok?: boolean } | null | undefined | Promise<{ ok?: boolean } | null | undefined>;
}

export const SESSION_FOLDER_TARGET_KEYS: readonly SessionFolderLaunchTarget[];

export function buildSessionFolderLaunchSpec(
  platform: string,
  target: SessionFolderLaunchTarget,
  workspacePath: string,
  resolveCommand?: (command: string) => string | null,
): SessionFolderLaunchSpec | null;

export function createSessionFolderLauncher(
  options?: SessionFolderLauncherOptions,
): {
  availableTargets(
    sessionId?: unknown,
  ): Promise<SessionFolderLaunchTargetsResult>;
  openSessionFolder(input?: {
    sessionId?: unknown;
    target?: unknown;
  }): Promise<SessionFolderLaunchResult>;
};
