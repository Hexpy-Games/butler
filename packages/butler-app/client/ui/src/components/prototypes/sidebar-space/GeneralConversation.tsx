import {
  Button,
  ButtonContainer,
  Clock3,
  FolderPlus,
  GitBranch,
  MessageFooter,
  MessageRow,
  Stack,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import styles from "./SpaceMockup.module.css";

export function GeneralConversation() {
  const items = useMock((s) => s.items);
  const open = useMock((s) => s.open);
  const setDialog = useMock((s) => s.setDialog);
  return (
    <>
      <div className={styles.intro}>
        <Typo.PanelTitle>#일반</Typo.PanelTitle>
        <Typo.Body className={styles.muted}>
          일상 대화와 예약 작업의 결과가 이어지는 곳입니다.
        </Typo.Body>
      </div>
      <MessageRow
        role="assistant"
        footer={
          <MessageFooter>
            <Clock3 size={14} />
            <span>예약한 아침 브리핑 · 오전 9:00</span>
          </MessageFooter>
        }
      >
        <Typo.SectionTitle>좋은 아침입니다.</Typo.SectionTitle>
        <Typo.Body>
          오늘 오후 2시에 팀 회의가 있습니다. 어제 요청하신 에이전트 UI 리서치도
          정리해 두었습니다.
        </Typo.Body>
      </MessageRow>
      <MessageRow role="user" footer={<MessageFooter>오전 9:12</MessageFooter>}>
        <Typo.Body>
          보험도 한번 정리해 보고 싶어. 기존 보장은 유지하면서 월 10만 원 안으로
          가능할까?
        </Typo.Body>
      </MessageRow>
      <MessageRow
        role="assistant"
        footer={<MessageFooter>오전 9:13</MessageFooter>}
      >
        <Stack gap="4">
          <Typo.Body>
            먼저 현재 가입한 보험에서 겹치는 보장을 살펴보면 좋겠습니다. 기존
            보장은 유지하고, 월 보험료 10만 원을 기준으로 비교해 드릴게요.
          </Typo.Body>
          <Typo.Body>
            증권을 보내 주시면 보장 내용과 월 보험료를 정리하겠습니다. 이
            이야기를 별도 대화로 이어가셔도 됩니다.
          </Typo.Body>
          <ButtonContainer size="sm">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({ type: "topic" })}
            >
              <GitBranch size={14} />새 주제대화 시작
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({ type: "project" })}
            >
              <FolderPlus size={14} />새 프로젝트 시작
            </Button>
          </ButtonContainer>
          {items
            .filter((row) => row.source === "general" && row.kind === "session")
            .map((row) => (
              <Button
                key={row.id}
                variant="inline"
                size="sm"
                onClick={() => open(row.id)}
              >
                이어서 만든 대화: {row.title} →
              </Button>
            ))}
        </Stack>
      </MessageRow>
    </>
  );
}
