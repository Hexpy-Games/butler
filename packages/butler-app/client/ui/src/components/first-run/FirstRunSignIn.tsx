import {
  AlertCircle, Button, ButtonContainer, Copy, Globe2, Notice, SetupWizardStepAction, Spinner, Stack, Typo,
} from "@/butler-ds";
import { CardGlyph } from "./CardGlyph";
import { FirstRunStepCard } from "./FirstRunStepCard";
import { signInScreenState, type SignInScreenState } from "./signInScreenState";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** One state mapping owns the sign-in title, description and actions. */
export function FirstRunSignIn({ flow }: { flow: FirstRunFlow }) {
  const { copy, signIn } = flow;
  const state = signInScreenState(signIn.phase, flow.commit);
  const stopped = state === "cancelled" || state === "timedout" || state === "failed";
  const title = state === "cancelled" ? copy.signInCancelled : state === "timedout" ? copy.signInTimedOut
    : state === "failed" ? copy.signInFailed : copy.signInTitle(copy.providerNames.chatgpt);
  const description = stopped ? state === "timedout" ? copy.signInTimedOutBody : copy.signInCancelledBody : copy.signInBody;
  return (
    <FirstRunStepCard flow={flow} contentKey={`signin:${state}`} icon={<CardGlyph cardId="chatgpt" />}
      title={title} description={description} onBack={flow.backToList}
      actions={stopped
        ? <SetupWizardStepAction variant="default" onClick={() => void signIn.start()}>{copy.retry}</SetupWizardStepAction>
        : <SetupWizardStepAction disabled={state !== "waiting"} onClick={() => void signIn.cancel()}>{copy.cancel}</SetupWizardStepAction>}
    >
      {stopped ? null : <SignInStatus flow={flow} state={state} />}
    </FirstRunStepCard>
  );
}

function SignInStatus({ flow, state }: { flow: FirstRunFlow; state: SignInScreenState }) {
  const { copy, signIn } = flow;
  const failed = state === "commitFailed";
  return (
    <Notice tone={failed ? "error" : "neutral"} icon={failed ? <AlertCircle size="md" /> : <Spinner size={14} />}
      message={<Stack as="span" gap="xs" role={failed ? "alert" : "status"}>
        <Typo.Body as="span" tone="secondary">{failed ? copy.finishFailed : state === "connecting" ? copy.connecting : copy.signInWaiting}</Typo.Body>
        {failed ? <Button size="sm" variant="inline" onClick={flow.commit.retry}>{copy.retry}</Button> : state === "waiting" && signIn.canCopyLink ? (
          <ButtonContainer as="span" size="sm">
            <Button iconStart={<Globe2 size="sm" />} size="sm" variant="inline" onClick={signIn.reopen}>{copy.signInReopen}</Button>
            <Button iconStart={<Copy size="sm" />} size="sm" variant="inline" onClick={() => void signIn.copyLink()}>{signIn.copied ? copy.linkCopied : copy.signInCopyLink}</Button>
          </ButtonContainer>
        ) : null}
      </Stack>}
    />
  );
}
