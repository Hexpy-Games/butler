import { GeneralConversation } from "./GeneralConversation";
import { SpaceProjectPreview } from "./SpaceProjectPreview";
import {
  ArrowLeft,
  Button,
  ButtonContainer,
  MessageFooter,
  MessageRow,
  Stack,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import styles from "./SpaceMockup.module.css";
import mentionStyles from "./SessionMention.module.css";
import { SessionMention } from "./SessionMention";
import { isProjectConversation } from "@/app/prototypes/sidebar-space/sample-data";

export function SpaceConversation() {
  const active = useMock((s) => s.active);
  const items = useMock((s) => s.items);
  const messages = useMock((s) => s.sent);
  const open = useMock((s) => s.open);
  const setDraft = useMock((s) => s.setDraft);
  const item = items.find((row) => row.id === active);
  return (
    <div className={styles.scroll}>
      <div className={styles.messages}>
        {active === "general" ? (
          <GeneralConversation />
        ) : item?.kind === "project" ? (
          <SpaceProjectPreview id={item.id} />
        ) : active === "new" ? (
          <div className={styles.empty}>
            <Typo.PanelTitle>어떤 이야기를 시작할까요?</Typo.PanelTitle>
            <Typo.Body className={styles.muted}>
              새 주제대화는 스페이스에 만들어집니다.
            </Typo.Body>
            <ButtonContainer size="sm">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft("오사카 여행을 계획해줘")}
              >
                여행 이야기로 스마트 그룹 체험
              </Button>
            </ButtonContainer>
            <Typo.Caption className={styles.muted}>
              목업에서는 여행 예시만 자동으로 묶입니다.
            </Typo.Caption>
          </div>
        ) : (
          <>
            {item?.source && (
              <ButtonContainer size="sm">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => open(item.source!)}
                >
                  <ArrowLeft size={14} />
                  원래 대화로
                </Button>
              </ButtonContainer>
            )}
            <MessageRow role="assistant">
              <Stack gap="4">
                <Typo.PanelTitle>{item?.title}</Typo.PanelTitle>
                <Typo.Body className={styles.context}>
                  {item?.preview ?? "이 대화의 메시지가 표시되는 자리입니다."}
                </Typo.Body>
                {item?.source && (
                  <Typo.Caption className={styles.muted}>
                    원래 대화는 그대로 두고, 관련 맥락을 이어받았습니다.
                  </Typo.Caption>
                )}
              </Stack>
            </MessageRow>
          </>
        )}
        {messages
          .filter((message) => message.sessionId === active)
          .map((message, index) => (
            <MessageRow
              key={index}
              role="user"
              footer={<MessageFooter>방금 · 목업</MessageFooter>}
            >
              <Typo.Body className={styles.context}>
                {message.parts.map((part, partIndex) => {
                  const target = items.find((row) => row.id === part.sessionId);
                  return target ? (
                    <a
                      key={partIndex}
                      href={`#session-${target.id}`}
                      className={mentionStyles.link}
                      onClick={(event) => {
                        event.preventDefault();
                        open(target.id);
                      }}
                    >
                      <SessionMention
                        title={part.text}
                        project={isProjectConversation(target, items)}
                      />
                    </a>
                  ) : (
                    part.text
                  );
                })}
              </Typo.Body>
            </MessageRow>
          ))}
      </div>
    </div>
  );
}
