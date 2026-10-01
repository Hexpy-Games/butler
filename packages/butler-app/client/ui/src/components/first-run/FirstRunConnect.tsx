import {
  AlertCircle,
  Button,
  ButlerThinkingMark,
  IconTile,
  Notice,
  SetupWizardContent,
  Stack,
  Typo,
} from "@/butler-ds";
import { FirstRunReplyLanguage } from "./FirstRunReplyLanguage";
import { FirstRunCustomServer } from "./FirstRunCustomServer";
import { FirstRunKeyForm } from "./FirstRunKeyForm";
import { FirstRunModelPicker } from "./FirstRunModelPicker";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import { MemoryModelStatus } from "./MemoryModelStatus";
import { FirstRunProviderList } from "./FirstRunProviderList";
import { FirstRunSignIn } from "./FirstRunSignIn";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** "Pick an AI" and its sub-views; a made choice waits here until Butler is ready. */
export function FirstRunConnect({ flow }: { flow: FirstRunFlow }) {
  const { copy, view, commit } = flow;
  if (commit.waitingForReady) return <FirstRunFinishing flow={flow} />;
  const failure = commit.failed ? (
    <Stack gap="none" role="alert">
      <Notice
        tone="error"
        icon={<AlertCircle size="md" />}
        message={copy.finishFailed}
        action={<Button size="sm" type="button" variant="outline" onClick={commit.retry}>{copy.retry}</Button>}
      />
    </Stack>
  ) : null;
  return (
    <>
      {view.kind === "list" ? <FirstRunProviderList flow={flow} />
        : view.kind === "signin" ? <FirstRunSignIn flow={flow} />
          : view.kind === "key" ? <FirstRunKeyForm cardId={view.cardId} flow={flow} key={view.cardId} />
            : view.kind === "local" ? (
              <FirstRunModelPicker body={copy.localBody} cardId="local" flow={flow} options={flow.local.options} title={copy.localTitle} />
            ) : view.kind === "custom" ? <FirstRunCustomServer flow={flow} />
              : <FirstRunModelPicker apiKey={view.apiKey} cardId="other" flow={flow} options={view.options} title={copy.customTitle} />}
      <SetupWizardContent width="wide">
        <MemoryModelStatus model={flow.readiness.memory_model} language={flow.language} retry={flow.retryPreparation} />
      </SetupWizardContent>
      {commit.connected ? <FirstRunReplyLanguage flow={flow} /> : null}
      {failure ? <SetupWizardContent width="wide">{failure}</SetupWizardContent> : null}
    </>
  );
}

/** A choice is made; the first chat opens as soon as Butler is ready. */
function FirstRunFinishing({ flow }: { flow: FirstRunFlow }) {
  return (
    <SetupWizardContent>
      <Stack cross="center" gap="md" data-test-class="first-run-finishing">
        <IconTile size="lg"><ButlerThinkingMark state="idle" /></IconTile>
        <Typo.H4 align="center" as="h1">{flow.copy.finishing}</Typo.H4>
        <FirstRunPrepStatus flow={flow} />
      </Stack>
    </SetupWizardContent>
  );
}
