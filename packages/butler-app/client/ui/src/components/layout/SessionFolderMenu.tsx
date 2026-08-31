import { useState } from "react";
import {
  getSessionFolderLaunchTargets,
  openSessionFolder,
  type SessionFolderLaunchTarget,
} from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  FolderOpen,
  Monitor,
  Terminal,
} from "@/butler-ds";

export function SessionFolderMenu({
  disabled,
  sessionId,
}: {
  disabled: boolean;
  sessionId: string;
}) {
  const [targets, setTargets] = useState<SessionFolderLaunchTarget[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadTargets(open: boolean): Promise<void> {
    if (!open) return;
    setLoading(true);
    try {
      const result = await getSessionFolderLaunchTargets(sessionId);
      setTargets(result.ok ? result.targets : []);
    } catch (error) {
      setTargets([]);
      notifyError(error, appCopy.sessionActions.folderUnavailable, {
        id: `session-folder-targets-${sessionId}`,
      });
    } finally {
      setLoading(false);
    }
  }

  async function launch(target: SessionFolderLaunchTarget): Promise<void> {
    try {
      const result = await openSessionFolder(sessionId, target);
      if (!result.ok) {
        notifyError(result, appCopy.sessionActions.folderLaunchFailed, {
          id: `session-folder-launch-${sessionId}`,
        });
      }
    } catch (error) {
      notifyError(error, appCopy.sessionActions.folderLaunchFailed, {
        id: `session-folder-launch-${sessionId}`,
      });
    }
  }

  return (
    <DropdownMenuSub onOpenChange={(open) => void loadTargets(open)}>
      <DropdownMenuSubTrigger disabled={disabled}>
        <FolderOpen size={14} /> {appCopy.sessionActions.openSessionFolder}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {loading ? (
          <DropdownMenuItem disabled>
            {appCopy.sessionActions.loadingFolderTargets}
          </DropdownMenuItem>
        ) : targets?.length ? (
          targets.map((target) => (
            <DropdownMenuItem
              key={target}
              onSelect={() => void launch(target)}
            >
              {target === "vscode" ? <Monitor size={14} /> : <Terminal size={14} />}
              {target === "vscode"
                ? appCopy.sessionActions.vsCode
                : appCopy.sessionActions.terminal}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            {appCopy.sessionActions.folderUnavailable}
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
