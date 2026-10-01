import { Button, ButtonContainer, NativeSelect, NativeSelectOption, SetupWizardContent, Stack, Typo } from "@/butler-ds";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Final field in the AI step, after every connection path has settled. */
export function FirstRunReplyLanguage({ flow }: { flow: FirstRunFlow }) {
  const { reply, copy } = flow;
  const label = flow.language === "ko" ? "답변 언어" : "Reply language";
  return (
    <SetupWizardContent width="wide">
      <Stack gap="sm">
        <Typo.Label as="label" htmlFor="first-run-reply-language">{label}</Typo.Label>
        <NativeSelect id="first-run-reply-language" value={reply.value ?? ""} disabled={!reply.value || reply.saving}
          onChange={(event) => reply.setValue(event.target.value as "ko" | "en")}>
          {!reply.value ? <NativeSelectOption value="">{copy.connecting}</NativeSelectOption> : null}
          <NativeSelectOption value="ko">한국어</NativeSelectOption>
          <NativeSelectOption value="en">English</NativeSelectOption>
        </NativeSelect>
        {reply.failed ? <Typo.Caption role="alert" tone="secondary">{copy.finishFailed}</Typo.Caption> : null}
      </Stack>
      <ButtonContainer size="lg">
        <Button size="lg" stretch disabled={!reply.value || reply.saving} onClick={reply.complete}>{flow.language === "ko" ? "시작" : "Start"}</Button>
        {reply.failed && !reply.value ? <Button size="lg" variant="outline" onClick={reply.retry}>{copy.retry}</Button> : null}
      </ButtonContainer>
    </SetupWizardContent>
  );
}
