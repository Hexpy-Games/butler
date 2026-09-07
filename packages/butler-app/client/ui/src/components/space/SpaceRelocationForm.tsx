import { Button, ButtonContainer, DialogDescription, DialogHeader, DialogTitle, Stack } from "@/butler-ds";
import { useOrganization, type SpaceDialog } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";

export function SpaceRelocationForm({ dialog, rows }: { dialog: Extract<SpaceDialog, { kind: "relocate" }>; rows: Map<string, SpaceRowData> }) {
  const pending = useOrganization(s => s.pending);
  const source = rows.get(dialog.sourceKey);
  const target = dialog.targetKey ? rows.get(dialog.targetKey) : undefined;
  return <Stack gap="4">
    <DialogHeader>
      <DialogTitle>대화의 작업 위치를 변경할까요?</DialogTitle>
      <DialogDescription>
        {source?.title} 대화를 {target?.title ?? "스페이스 최상위"}(으)로 이동합니다.
        대화 기록과 기존 파일은 보존되며, 이후 작업은 새 소속의 작업 폴더와 프로젝트 지식을 사용합니다.
        진행 중인 작업이 있으면 완료한 뒤 이동할 수 있습니다.
      </DialogDescription>
    </DialogHeader>
    <ButtonContainer size="sm" justify="end">
      <Button variant="secondary" disabled={pending} onClick={() => useOrganization.getState().setDialog(null)}>취소</Button>
      <Button disabled={pending || !source?.session} onClick={() => {
        if (source?.session) void useOrganization.getState().mutate({ action: "relocate", sessionId: source.session.id,
          targetKey: dialog.targetKey, position: dialog.position, operationId: dialog.operationId });
      }}>{pending ? "이동 중…" : "이동"}</Button>
    </ButtonContainer>
  </Stack>;
}
