import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, ComposerDecisionPanel, Key, Square, Typo } from "@/butler-ds";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";

/** A sign-in step only the user can do: open the tab (desktop) or stop. The hand-back resolves it; nothing to allow. */
export function ComposerSignInHandoffSurface({ decision }: { decision: ComposerAuthorityDecision & Required<Pick<ComposerAuthorityDecision, "handoff">> }) {
  useAppLocale();
  const copy = appCopy.interfaceTemplates.approvalRequest.signInHandoff;
  const { handoff } = decision;
  return <ComposerDecisionPanel
    icon={<Key aria-hidden="true" size="lg" />}
    eyebrow={copy.eyebrow}
    title={decision.title}
    details={decision.details}
    onOpen={decision.onOpenSource}
    aside={decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : undefined}
    data-test-class="composer-signin-handoff"
    actions={<ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" iconStart={<Square size="sm" />} onClick={handoff.onStop}>{copy.stop}</Button>
      {handoff.canOpenTab && <Button type="button" size="sm" onClick={handoff.onOpenTab}>{copy.openTab}</Button>}
    </ButtonContainer>}
  />;
}
