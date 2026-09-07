import { useState } from "react";
import {
  ButtonContainer,
  ComposerCard,
  ComposerCardExpandedBody,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerSendButton,
  IconButton,
  Plus,
  ShieldCheck,
  Typo,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import styles from "./SpaceMockup.module.css";
import { InlineDraft } from "./InlineDraft";

export function SpaceComposer() {
  const draft = useMock((s) => s.draft);
  const attach = useMock((s) => s.attach);
  const send = useMock((s) => s.send);
  const setDialog = useMock((s) => s.setDialog);
  const [dragging, setDragging] = useState(false);
  return (
    <div className={styles.composer}>
      <ComposerCard
        dropActive={dragging}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const id = event.dataTransfer.getData(
            "application/x-butler-mock-session",
          );
          if (useMock.getState().items.some((item) => item.id === id))
            attach(id);
        }}
      >
        <ComposerCardExpandedBody>
          <InlineDraft />
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <ButtonContainer size="icon-sm">
            <IconButton
              label="대화 참조 추가"
              onClick={() => setDialog({ type: "reference" })}
            >
              <Plus />
            </IconButton>
            <ShieldCheck size={18} aria-label="권한 표시 예시" />
          </ButtonContainer>
          <ComposerCardToolbarSpacer />
          <Typo.Caption className={styles.muted}>미리보기</Typo.Caption>
          <ComposerSendButton
            disabled={!draft.trim()}
            aria-label="샘플 메시지 보내기"
          />
        </ComposerCardToolbar>
      </ComposerCard>
    </div>
  );
}
