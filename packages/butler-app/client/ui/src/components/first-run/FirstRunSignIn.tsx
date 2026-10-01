import {
  AlertCircle,
  Button,
  ButtonContainer,
  Globe2,
  IconTile,
  Inline,
  SetupWizardContent,
  Spinner,
  Stack,
  Typo,
} from "@/butler-ds";
import { FirstRunBack } from "./FirstRunBack";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** ChatGPT sign-in: waiting for the browser, or cancelled/failed with a way back. */
export function FirstRunSignIn({ flow }: { flow: FirstRunFlow }) {
  const { copy, signIn } = flow;
  const stopped = signIn.phase === "cancelled" || signIn.phase === "failed";
  return (
    <SetupWizardContent width="wide">
      <Inline>
        <FirstRunBack label={copy.backToList} onClick={flow.backToList} />
      </Inline>
      {stopped ? (
        <Stack cross="center" gap="md" role="alert">
          <IconTile size="lg" tone="danger"><AlertCircle size="xl" /></IconTile>
          <Typo.H4 align="center" as="h1">{signIn.phase === "failed" ? copy.signInFailed : copy.signInCancelled}</Typo.H4>
          <Typo.Body align="center" tone="secondary">{copy.signInCancelledBody}</Typo.Body>
          <ButtonContainer size="default">
            <Button type="button" onClick={() => void signIn.start()}>{copy.retry}</Button>
            <Button type="button" variant="ghost" onClick={flow.backToList}>{copy.chooseOther}</Button>
          </ButtonContainer>
        </Stack>
      ) : (
        <Stack cross="center" gap="md">
          <IconTile size="lg"><Globe2 size="xl" /></IconTile>
          <Typo.H4 align="center" as="h1">{copy.signInTitle}</Typo.H4>
          <Inline justify="center" role="status">
            {!flow.commit.connected ? <Spinner size={14} /> : null}
            <Typo.Body tone="secondary">{flow.commit.connected ? copy.keyValid : flow.commit.pending ? copy.connecting : copy.signInBody}</Typo.Body>
          </Inline>
          {!flow.commit.connected ? <ButtonContainer size="default">
            <Button type="button" variant="outline" onClick={() => void signIn.cancel()}>{copy.cancel}</Button>
          </ButtonContainer> : null}
          {!flow.commit.connected && signIn.canCopyLink ? (
            <Button size="sm" type="button" variant="link" onClick={() => void signIn.copyLink()}>
              {signIn.copied ? copy.linkCopied : copy.signInCopyLink}
            </Button>
          ) : null}
        </Stack>
      )}
    </SetupWizardContent>
  );
}
