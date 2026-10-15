import { Field, FieldLabel, NativeSelect, NativeSelectOption, SetupWizardStepAction, Typo } from "@/butler-ds";
import { SUPPORTED_UI_LANGUAGES } from "@/app/firstRunSetup.ts";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** AI step ③: the reply language; Next saves it and ends the AI step. */
export function FirstRunReplyLanguage({ flow }: { flow: FirstRunFlow }) {
  const { copy, reply } = flow;
  return (
    <FirstRunStepCard flow={flow} contentKey="reply" title={copy.replyTitle}
      titleId="first-run-reply-title" description={copy.replyBody} onBack={flow.backFromReply}
      footerStart={!flow.commit.connected ? <FirstRunPrepStatus flow={flow} /> : undefined}
      actions={<>
        {reply.failed && !reply.value ? <SetupWizardStepAction onClick={reply.retry}>{copy.retry}</SetupWizardStepAction> : null}
        <SetupWizardStepAction forward disabled={!reply.value || reply.saving} onClick={reply.save}>{copy.next}</SetupWizardStepAction>
      </>}
    >
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
