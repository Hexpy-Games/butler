import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { Button, ButtonContainer, DialogForm, Field, FieldLabel, Input, Typo } from "@/butler-ds";
import { useSessionBranch } from "./hooks/useSessionBranch";

export function SessionBranchForm({ sourceSessionId, sourceMessageId, project, topicProjectId = null, onClose, onPendingChange }: {
  sourceSessionId: string; sourceMessageId: string; project: boolean;
  /** A new conversation (not project) is created in this project when set. */
  topicProjectId?: string | null;
  onClose(): void; onPendingChange(pending: boolean): void;
}) {
  useAppLocale();
  const [title, setTitle] = useState("");
  const branch = useSessionBranch();
  useEffect(() => { onPendingChange(branch.pending); return () => onPendingChange(false); }, [branch.pending, onPendingChange]);
  const submit = () => {
    void branch.create({ sourceSessionId, sourceMessageId, title: title.trim(),
      destination: project ? { kind: "new_project", name: title.trim() }
        : topicProjectId ? { kind: "project", projectId: topicProjectId } : { kind: "chat" },
    }).then(created => { if (created) onClose(); });
  };
  return <DialogForm dialog
    title={project ? appCopy.interfaceStatus.branchProject : appCopy.interfaceStatus.branchChat}
    description={appCopy.interfaceStatus.branchDescription}
    onSubmit={submit}
    footer={<ButtonContainer size="sm" justify="end">
      <Button size="sm" type="button" variant="ghost" disabled={branch.pending} onClick={onClose}>{appCopy.interfaceStatus.close}</Button>
      <Button size="sm" type="submit" disabled={branch.pending || !title.trim()}>
        {branch.error ? appCopy.interfaceStatus.retry : appCopy.interfaceStatus.create}
      </Button>
    </ButtonContainer>}>
    <Field>
      <FieldLabel htmlFor="branch-title">{project ? appCopy.interfaceStatus.projectName : appCopy.interfaceStatus.conversationTitle}</FieldLabel>
      <Input id="branch-title" autoFocus value={title} maxLength={120}
        disabled={branch.reserved} onChange={event => setTitle(event.target.value)} />
    </Field>
    {branch.pending && <Typo.Body role="status">{appCopy.interfaceStatus.branchPending}</Typo.Body>}
    {branch.error && <Typo.Body role="alert">{branch.error}</Typo.Body>}
  </DialogForm>;
}
