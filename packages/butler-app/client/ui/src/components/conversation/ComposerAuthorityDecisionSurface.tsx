import {
  Button, ButtonContainer, ChevronDown, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger, ShieldCheck, Typo,
} from "@/butler-ds";
import { ComposerDecisionSurface } from "./ComposerDecisionSurface";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";
import styles from "./ComposerAuthorityDecisionSurface.module.css";

export function ComposerAuthorityDecisionSurface({ decision }: { decision: ComposerAuthorityDecision }) {
  return <ComposerDecisionSurface
    icon={<ShieldCheck aria-hidden="true" size={18} />}
    title={decision.title}
    onOpen={decision.onOpenSource}
    error={decision.error}
    aside={<>
      {decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : null}
      <Button type="button" size="sm" variant="borderless" aria-label="나중에 결정하고 메시지 작성" title="나중에 결정하고 메시지 작성" onClick={decision.onComposeMessage}>
        <ChevronDown aria-hidden="true" size={16} />
      </Button>
    </>}
    testClass="composer-authority-decision"
    actions={<ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="outline" disabled={decision.pending} onClick={decision.onOpenInstruction}>직접 입력</Button>
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={decision.onDeny}>거절</Button>
      <div className={styles.split}>
        <Button type="button" size="sm" disabled={decision.pending} onClick={decision.onAllow}>이번만 허용</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" className={styles.arrow} disabled={decision.pending || !decision.scope} aria-label="허용 범위 선택">
              <ChevronDown aria-hidden="true" size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className={styles.menu}>
            <DropdownMenuItem onSelect={decision.onAllowConversation}>
              <span className={styles.option}>
                <span>이 대화에서 계속 허용</span>
                <span className={styles.scope}>{decision.scope?.description}</span>
                <span className={styles.scope}>현재 요청을 실행하고, 이 대화의 하위 작업에도 적용합니다.</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ButtonContainer>}
  />;
}
