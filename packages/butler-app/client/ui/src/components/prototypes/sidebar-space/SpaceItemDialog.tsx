import { useState } from "react";
import {
  Button,
  ButtonContainer,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";

export function SpaceItemDialog() {
  const dialog = useMock((s) => s.dialog)!;
  const item = useMock((s) => s.items.find((row) => row.id === dialog.id))!;
  const rename = useMock((s) => s.renameGroup);
  const remove = useMock((s) => s.removeItem);
  const setDialog = useMock((s) => s.setDialog);
  const [name, setName] = useState(item.title);
  const deleting = dialog.type === "delete-project";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{deleting ? "프로젝트 삭제" : "이름 변경"}</DialogTitle>
        <DialogDescription>
          {deleting
            ? `${item.title}와 하위 대화를 목업 목록에서 삭제합니다. 실제 파일은 삭제하지 않습니다.`
            : "목업에서 표시할 이름을 바꿉니다."}
        </DialogDescription>
      </DialogHeader>
      {!deleting && (
        <Input
          aria-label="이름"
          autoFocus
          value={name}
          onFocus={(event) => event.target.select()}
          onChange={(event) => setName(event.target.value)}
        />
      )}
      <DialogFooter>
        <ButtonContainer size="sm" justify="end">
          <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>
            취소
          </Button>
          <Button
            size="sm"
            disabled={!deleting && !name.trim()}
            onClick={() =>
              deleting
                ? remove(item.id, "delete")
                : rename(item.id, name.trim())
            }
          >
            {deleting ? "삭제" : "저장"}
          </Button>
        </ButtonContainer>
      </DialogFooter>
    </>
  );
}
