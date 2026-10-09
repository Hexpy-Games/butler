import {
  ButlerThinkingMark, CheckCircle2, Field, FieldLabel, NativeSelect, NativeSelectOption, Notice, SetupWizardStepAction, Typo,
} from "@/butler-ds";
import { SUPPORTED_UI_LANGUAGES } from "@/app/firstRunSetup.ts";
import { CardGlyph } from "./CardGlyph";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** The fourth step owns preparation waiting and the final reply-language choice. */
export function FirstRunReady({ flow }: { flow: FirstRunFlow }) {
  const { copy, commit, reply } = flow;
  if (!commit.connected) return (
    <FirstRunStepCard flow={flow} contentKey="finishing" icon={<ButlerThinkingMark size="lg" state="working" />}
      title={copy.finishing} footerStart={<FirstRunPrepStatus flow={flow} />}>
      <Typo.Caption as="div" data-test-class="first-run-finishing">{null}</Typo.Caption>
    </FirstRunStepCard>
  );
  const cardId = commit.connected.cardId;
  return (
    <FirstRunStepCard flow={flow} contentKey={`ready:${cardId}`} icon={<CardGlyph cardId={cardId} />}
      title={copy.readyTitle(copy.providerNames[cardId])} description={copy.readyBody} onBack={flow.backToList}
      actions={<>
        {reply.failed && !reply.value ? <SetupWizardStepAction onClick={reply.retry}>{copy.retry}</SetupWizardStepAction> : null}
        <SetupWizardStepAction forward disabled={!reply.value || reply.saving} onClick={reply.complete}>{copy.finish}</SetupWizardStepAction>
      </>}
    >
      {cardId === "chatgpt" && flow.signIn.account ? <Notice tone="neutral" icon={<CheckCircle2 size="md" />} message={flow.signIn.account} /> : null}
      <Field>
        <FieldLabel htmlFor="first-run-reply-language">{copy.replyLanguage}</FieldLabel>
        <NativeSelect id="first-run-reply-language" stretch value={reply.value ?? ""} disabled={!reply.value || reply.saving}
          onChange={(event) => reply.setValue(event.target.value as "ko" | "en")}>
          {!reply.value ? <NativeSelectOption value="">{copy.connecting}</NativeSelectOption> : null}
          {SUPPORTED_UI_LANGUAGES.map(({ value, label }) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect>
        {reply.failed ? <Typo.Caption role="alert" tone="secondary">{copy.finishFailed}</Typo.Caption> : null}
      </Field>
    </FirstRunStepCard>
  );
}
