import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, ChevronDown, ComposerDecisionPanel, ShieldCheck, SplitButton, Typo } from "@/butler-ds";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";

export function ComposerAuthorityDecisionSurface({ decision }: { decision: ComposerAuthorityDecision }) {
  useAppLocale();
  return <ComposerDecisionPanel
    icon={<ShieldCheck aria-hidden="true" size="lg" />}
    title={decision.title}
    onOpen={decision.onOpenSource}
    error={decision.error}
    aside={<>
      {decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : null}
      <Button type="button" size="sm" variant="borderless" aria-label={appCopy.interfaceDetails.composeLater} title={appCopy.interfaceDetails.composeLater} onClick={decision.onComposeMessage}>
        <ChevronDown aria-hidden="true" size="md" />
      </Button>
    </>}
    data-test-class="composer-authority-decision"
    actions={<ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={decision.onDeny}>{appCopy.interfaceDetails.deny}</Button>
      <SplitButton size="sm" text={appCopy.interfaceDetails.allowOnce} disabled={decision.pending} onClick={decision.onAllow}
        menuLabel={appCopy.interfaceDetails.allowScope} menuSide="top"
        items={[{
          key: "conversation", label: appCopy.interfaceDetails.allowConversation, disabled: !decision.scope,
          description: [decision.scope?.description, appCopy.interfaceDetails.allowDescription], onSelect: decision.onAllowConversation,
        }]} />
    </ButtonContainer>}
  />;
}
