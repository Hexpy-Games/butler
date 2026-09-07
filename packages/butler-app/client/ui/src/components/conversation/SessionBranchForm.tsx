import { useEffect, useState } from "react";
import { Button, ButtonContainer, DialogTitle, DialogDescription, DialogHeader,
  Field, FieldLabel, Input, Stack, Typo } from "@/butler-ds";
import { useSessionBranch } from "./hooks/useSessionBranch";

export function SessionBranchForm({ sourceSessionId, sourceMessageId, project, onClose, onPendingChange }: {
  sourceSessionId: string; sourceMessageId: string; project: boolean; onClose(): void; onPendingChange(pending: boolean): void;
}) {
  const [title, setTitle] = useState("");
  const branch = useSessionBranch();
  useEffect(() => { onPendingChange(branch.pending); return () => onPendingChange(false); }, [branch.pending, onPendingChange]);
  return <form onSubmit={event => {
    event.preventDefault();
    void branch.create({ sourceSessionId, sourceMessageId, title: title.trim(),
      destination: project ? { kind: "new_project", name: title.trim() } : { kind: "chat" },
    }).then(created => { if (created) onClose(); });
  }}>
    <Stack gap="md">
      <DialogHeader>
        <DialogTitle>{project ? "새 프로젝트 시작" : "새 주제대화 시작"}</DialogTitle>
        <DialogDescription>이 답변까지의 요청과 결정을 정리해 이어갑니다. 원래 대화는 그대로 남습니다.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="branch-title">{project ? "프로젝트 이름" : "대화 제목"}</FieldLabel>
        <Input id="branch-title" autoFocus value={title} maxLength={120}
          disabled={branch.reserved} onChange={event => setTitle(event.target.value)} />
      </Field>
      {branch.pending && <Typo.Body role="status">대화의 맥락을 정리하고 있습니다.</Typo.Body>}
      {branch.error && <Typo.Body role="alert">{branch.error}</Typo.Body>}
      <ButtonContainer size="sm" justify="end">
        <Button size="sm" type="button" variant="ghost" disabled={branch.pending} onClick={onClose}>닫기</Button>
        <Button size="sm" type="submit" disabled={branch.pending || !title.trim()}>
          {branch.error ? "다시 시도" : "만들기"}
        </Button>
      </ButtonContainer>
    </Stack>
  </form>;
}
