import { useState } from "react";
import {
  Button,
  ButtonContainer,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Stack,
} from "@/butler-ds";
import { useOrganization, type SpaceDialog } from "@/app/space/organization";

export function SpaceGroupForm({
  dialog,
}: {
  dialog: Extract<SpaceDialog, { kind: "create" | "rename" }>;
}) {
  const [title, setTitle] = useState(
    dialog.kind === "rename" ? dialog.title : "",
  );
  const pending = useOrganization((s) => s.pending);
  const mutate = useOrganization((s) => s.mutate);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void mutate(
          dialog.kind === "create"
            ? {
                action: "create",
                title: title.trim(),
                parentKey: dialog.parentKey,
              }
            : {
                action: "rename",
                groupId: dialog.groupId,
                title: title.trim(),
              },
        );
      }}
    >
      <Stack gap="4">
        <DialogHeader>
          <DialogTitle>
            {dialog.kind === "create" ? "그룹 만들기" : "그룹 이름 변경"}
          </DialogTitle>
          <DialogDescription>
            대화와 프로젝트를 원하는 이름으로 정리합니다.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="space-group-title">그룹 이름</FieldLabel>
          <Input
            id="space-group-title"
            autoFocus
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <ButtonContainer size="sm" justify="end">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => useOrganization.getState().setDialog(null)}
          >
            취소
          </Button>
          <Button size="sm" type="submit" disabled={pending || !title.trim()}>
            저장
          </Button>
        </ButtonContainer>
      </Stack>
    </form>
  );
}
