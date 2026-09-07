import { useState } from "react";
import {
  Button,
  ButtonContainer,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Stack,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { branchContext } from "@/app/prototypes/sidebar-space/sample-data";
import styles from "./SpaceMockup.module.css";

export function CreateSpaceDialog({
  kind,
}: {
  kind: "topic" | "project" | "group" | "rename-group";
}) {
  const groupId = useMock((s) => s.dialog?.id);
  const groupTitle = useMock(
    (s) => s.items.find((item) => item.id === groupId)?.title,
  );
  const isGroup = kind === "group" || kind === "rename-group";
  const [title, setTitle] = useState(
    kind === "rename-group"
      ? (groupTitle ?? "새 그룹")
      : kind === "group"
        ? ""
        : "보험 비교와 정리",
  );
  const create = useMock((s) => s.create);
  const renameGroup = useMock((s) => s.renameGroup);
  const setDialog = useMock((s) => s.setDialog);
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {kind === "rename-group"
            ? "그룹 이름"
            : kind === "group"
              ? "그룹 만들기"
              : kind === "topic"
                ? "새 주제대화 시작"
                : "새 프로젝트 시작"}
        </DialogTitle>
        <DialogDescription>
          {kind === "rename-group"
            ? "두 대화를 묶었습니다. 그룹 이름은 그대로 두셔도 됩니다."
            : kind === "group"
              ? "대화와 프로젝트를 함께 정리할 수 있습니다."
              : "관련 맥락을 이어받습니다. 원래 대화는 그대로 남습니다."}
        </DialogDescription>
      </DialogHeader>
      <Stack gap="4">
        <label>
          <Typo.Label>이름</Typo.Label>
          <Input
            autoFocus
            onFocus={(event) => event.target.select()}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="예: 건강"
          />
        </label>
        {!isGroup && (
          <Stack gap="2">
            <Typo.SectionTitle>이어서 가져갈 내용</Typo.SectionTitle>
            <Typo.Body className={styles.context}>{branchContext}</Typo.Body>
            <Typo.Caption className={styles.muted}>
              출처: #일반 · 오전 9:12–9:13의 대화
            </Typo.Caption>
          </Stack>
        )}
        {kind === "project" && (
          <Typo.Caption className={styles.muted}>
            프로젝트 생성 화면의 예시입니다. 실제 작업 폴더는 만들지 않습니다.
          </Typo.Caption>
        )}
      </Stack>
      <DialogFooter>
        <ButtonContainer size="sm" justify="end">
          <Button size="sm" variant="ghost" onClick={() => setDialog(null)}>
            {kind === "rename-group" ? "나중에" : "취소"}
          </Button>
          <Button
            size="sm"
            disabled={!title.trim()}
            onClick={() =>
              kind === "rename-group"
                ? renameGroup(groupId!, title.trim())
                : create(kind, title.trim(), branchContext)
            }
          >
            {kind === "rename-group"
              ? "완료"
              : kind === "group"
                ? "그룹 만들기"
                : "만들고 열기"}
          </Button>
        </ButtonContainer>
      </DialogFooter>
    </>
  );
}
