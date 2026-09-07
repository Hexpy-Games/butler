import { useState } from "react";
import { Dialog, DialogContent, FolderPlus, MessageSquarePlus, Tooltip } from "@/butler-ds";
import { SessionBranchForm } from "./SessionBranchForm";

export function BranchMessageActions({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const [mode, setMode] = useState<"topic" | "project" | null>(null);
  const [pending, setPending] = useState(false);
  return <>
    <Tooltip label="새 주제대화 시작">
      <button type="button" aria-label="새 주제대화 시작" onClick={() => setMode("topic")}><MessageSquarePlus size={14} /></button>
    </Tooltip>
    <Tooltip label="새 프로젝트 시작">
      <button type="button" aria-label="새 프로젝트 시작" onClick={() => setMode("project")}><FolderPlus size={14} /></button>
    </Tooltip>
    <Dialog open={mode !== null} onOpenChange={open => { if (!open && !pending) setMode(null); }}>
      <DialogContent>
        {mode && <SessionBranchForm key={mode} sourceSessionId={sessionId} sourceMessageId={messageId}
          project={mode === "project"} onPendingChange={setPending} onClose={() => setMode(null)} />}
      </DialogContent>
    </Dialog>
  </>;
}
