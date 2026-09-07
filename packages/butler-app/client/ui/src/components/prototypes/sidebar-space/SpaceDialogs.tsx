import { CreateSpaceDialog } from "./CreateSpaceDialog";
import { SpaceItemDialog } from "./SpaceItemDialog";
import { ConversationIcon } from "./ConversationIcon";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Folder,
  Input,
  NavRow,
  SidebarNav,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { locationOf } from "@/app/prototypes/sidebar-space/sample-data";
import styles from "./SpaceMockup.module.css";

function ChooseContent({
  kind,
  id,
}: {
  kind: "search" | "reference" | "move";
  id?: string;
}) {
  const [query, setQuery] = useState("");
  const items = useMock((s) => s.items);
  const open = useMock((s) => s.open);
  const attach = useMock((s) => s.attach);
  const move = useMock((s) => s.move);
  const setDialog = useMock((s) => s.setDialog);
  const candidates = items.filter(
    (item) =>
      (kind === "move" ? item.kind !== "session" : item.kind === "session") &&
      item.title.includes(query),
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {kind === "move"
            ? "대화 이동"
            : kind === "reference"
              ? "대화 참조 추가"
              : "대화 검색"}
        </DialogTitle>
        <DialogDescription>
          {kind === "move"
            ? "그룹은 정리 위치만 바꿉니다. 프로젝트로 이동하면 이후 작업의 프로젝트도 달라집니다."
            : kind === "reference"
              ? "현재 대화에 참고할 대화를 첨부합니다. 원본의 위치는 바뀌지 않습니다."
              : "제목으로 샘플 대화를 찾아보세요."}
        </DialogDescription>
      </DialogHeader>
      <Input
        aria-label="대화 또는 위치 검색"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={
          kind === "move" ? "그룹 또는 프로젝트 찾기" : "대화 제목 검색"
        }
      />
      <div className={styles.choices}>
        <SidebarNav>
          {kind === "move" && (
            <NavRow label="스페이스 최상위" onClick={() => move(id!, null)} />
          )}
          {candidates.map((item) => (
            <NavRow
              key={item.id}
              icon={
                item.kind !== "session" ? (
                  <Folder />
                ) : (
                  <ConversationIcon id={item.id} />
                )
              }
              label={
                <span className={styles.flatLabel}>
                  {item.title}
                  <Typo.Caption className={styles.muted}>
                    {item.kind === "project"
                      ? "프로젝트 · 작업 맥락 변경"
                      : locationOf(item, items)}
                  </Typo.Caption>
                </span>
              }
              onClick={() => {
                if (kind === "move") move(id!, item.id);
                else if (kind === "reference") attach(item.id);
                else {
                  open(item.id);
                  setDialog(null);
                }
              }}
            />
          ))}
          {!candidates.length && (
            <Typo.Body className={styles.muted}>
              일치하는 항목이 없습니다.
            </Typo.Body>
          )}
        </SidebarNav>
      </div>
    </>
  );
}

export function SpaceDialogs() {
  const dialog = useMock((s) => s.dialog);
  const setDialog = useMock((s) => s.setDialog);
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open) setDialog(null);
      }}
    >
      <DialogContent>
        {dialog &&
          (dialog.type === "rename" || dialog.type === "delete-project" ? (
            <SpaceItemDialog key={`${dialog.type}-${dialog.id}`} />
          ) : dialog.type === "topic" ||
            dialog.type === "project" ||
            dialog.type === "rename-group" ||
            dialog.type === "group" ? (
            <CreateSpaceDialog key={dialog.type} kind={dialog.type} />
          ) : (
            <ChooseContent
              key={dialog.type}
              kind={dialog.type}
              id={dialog.id}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}
