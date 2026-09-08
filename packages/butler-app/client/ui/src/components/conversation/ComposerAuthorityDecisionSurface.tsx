import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  Button, ButtonContainer, ChevronDown, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger, ShieldCheck, Typo,
} from "@/butler-ds";
import { ComposerDecisionSurface } from "./ComposerDecisionSurface";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";
import styles from "./ComposerAuthorityDecisionSurface.module.css";

export function ComposerAuthorityDecisionSurface({ decision }: { decision: ComposerAuthorityDecision }) {
  useAppLocale();
  return <ComposerDecisionSurface
    icon={<ShieldCheck aria-hidden="true" size={18} />}
    title={decision.title}
    onOpen={decision.onOpenSource}
    error={decision.error}
    aside={<>
      {decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : null}
      <Button type="button" size="sm" variant="borderless" aria-label={appCopy.interfaceDetails.composeLater} title={appCopy.interfaceDetails.composeLater} onClick={decision.onComposeMessage}>
        <ChevronDown aria-hidden="true" size={16} />
      </Button>
    </>}
    testClass="composer-authority-decision"
    actions={<ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={decision.onDeny}>{appCopy.interfaceDetails.deny}</Button>
      <div className={styles.split}>
        <Button type="button" size="sm" disabled={decision.pending} onClick={decision.onAllow}>{appCopy.interfaceDetails.allowOnce}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" className={styles.arrow} disabled={decision.pending || !decision.scope} aria-label={appCopy.interfaceDetails.allowScope}>
              <ChevronDown aria-hidden="true" size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className={styles.menu}>
            <DropdownMenuItem onSelect={decision.onAllowConversation}>
              <span className={styles.option}>
                <span>{appCopy.interfaceDetails.allowConversation}</span>
                <span className={styles.scope}>{decision.scope?.description}</span>
                <span className={styles.scope}>{appCopy.interfaceDetails.allowDescription}</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ButtonContainer>}
  />;
}
