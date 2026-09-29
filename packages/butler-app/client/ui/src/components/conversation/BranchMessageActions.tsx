import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Dialog, DialogContent, FolderPlus, IconButton, MessageSquarePlus } from "@/butler-ds";
import { SessionBranchForm } from "./SessionBranchForm";

export function BranchMessageActions({ sessionId, messageId, projectId = null }: {
  sessionId: string; messageId: string; projectId?: string | null;
}) {
  useAppLocale();
  const [mode, setMode] = useState<"topic" | "project" | null>(null);
  const [pending, setPending] = useState(false);
  return <>
    <IconButton label={appCopy.interfaceStatus.branchChat} onClick={() => setMode("topic")}>
      <MessageSquarePlus size="sm" />
    </IconButton>
    <IconButton label={appCopy.interfaceStatus.branchProject} onClick={() => setMode("project")}>
      <FolderPlus size="sm" />
    </IconButton>
    <Dialog open={mode !== null} onOpenChange={open => { if (!open && !pending) setMode(null); }}>
      <DialogContent closeLabel={appCopy.common.close}>
        {mode && <SessionBranchForm key={mode} sourceSessionId={sessionId} sourceMessageId={messageId}
          project={mode === "project"} topicProjectId={projectId}
          onPendingChange={setPending} onClose={() => setMode(null)} />}
      </DialogContent>
    </Dialog>
  </>;
}
