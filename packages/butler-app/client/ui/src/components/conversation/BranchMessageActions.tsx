import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Dialog, DialogContent, FolderPlus, MessageSquarePlus, Tooltip } from "@/butler-ds";
import { SessionBranchForm } from "./SessionBranchForm";

export function BranchMessageActions({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  useAppLocale();
  const [mode, setMode] = useState<"topic" | "project" | null>(null);
  const [pending, setPending] = useState(false);
  return <>
    <Tooltip label={appCopy.interfaceStatus.branchChat}>
      <button type="button" aria-label={appCopy.interfaceStatus.branchChat} onClick={() => setMode("topic")}><MessageSquarePlus size={14} /></button>
    </Tooltip>
    <Tooltip label={appCopy.interfaceStatus.branchProject}>
      <button type="button" aria-label={appCopy.interfaceStatus.branchProject} onClick={() => setMode("project")}><FolderPlus size={14} /></button>
    </Tooltip>
    <Dialog open={mode !== null} onOpenChange={open => { if (!open && !pending) setMode(null); }}>
      <DialogContent>
        {mode && <SessionBranchForm key={mode} sourceSessionId={sessionId} sourceMessageId={messageId}
          project={mode === "project"} onPendingChange={setPending} onClose={() => setMode(null)} />}
      </DialogContent>
    </Dialog>
  </>;
}
