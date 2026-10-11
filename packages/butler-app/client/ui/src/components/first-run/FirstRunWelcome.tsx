import { faviconSrc } from "@/app/favicons.ts";
import { useEffect } from "react";
import {
  Button,
  ButtonContainer,
  ButlerThinkingMark,
  IconTile,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  SetupWizardContent,
  Stack,
  Inline,
  InlineReference,
  Typo,
} from "@/butler-ds";
import { SUPPORTED_UI_LANGUAGES, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { FirstRunPrepStatus, PreparationLine } from "./FirstRunPrepStatus";
import { MemoryModelStatus } from "./MemoryModelStatus";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Opens the Butler user manual's first-run page in the system browser. */
export const FIRST_RUN_GUIDE_URL = "https://butler.hexpy.games/help/getting-started/first-run/";

/** Welcome: introduction, interface language and the start action. */
export function FirstRunWelcome({ flow }: { flow: FirstRunFlow }) {
  const { copy, readiness } = flow;
  useEffect(() => {
    if (flow.focusStart) document.getElementById("first-run-start")?.focus({ preventScroll: true });
  }, [flow.focusStart]);
  const blocked = readiness.status === "failed";
  return (
    <SetupWizardContent surface="solid">
      <Stack cross="center" gap="md">
        <IconTile size="xl" tone="plain">
          <ButlerThinkingMark state={readiness.status === "preparing" ? "working" : "idle"} />
        </IconTile>
        <Typo.H3 align="center" as="h1">{copy.welcomeTitle}</Typo.H3>
        <Typo.Body align="center" tone="secondary">{copy.welcomeLede}</Typo.Body>
      </Stack>
      <Field>
        <FieldLabel htmlFor="first-run-language">{copy.interfaceLanguage}</FieldLabel>
        <NativeSelect
          id="first-run-language"
          size="sm"
          stretch
          value={flow.language}
          onChange={(event) => flow.setLanguage(event.target.value as FirstRunLanguage)}
        >
          {SUPPORTED_UI_LANGUAGES.map(({ value, label }) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
      <Stack gap="sm">
        <ButtonContainer size="lg" align="column" cross="stretch">
          <Button
            id="first-run-start"
            disabled={blocked || flow.savingConsent}
            size="lg"
            stretch
            title={blocked ? copy.agreeBlocked : undefined}
            type="button"
            onClick={flow.start}
          >
            {copy.start}
          </Button>
          {flow.mode === "rerun" ? <FirstRunCancel flow={flow} /> : null}
        </ButtonContainer>
        {blocked ? <FirstRunPrepStatus flow={flow} /> : <>
          <Inline gap="sm" justify="center" cross="center">
            <PreparationLine flow={flow} />
            <Typo.Caption tone="tertiary" aria-hidden="true">·</Typo.Caption>
            <Typo.Caption as="span"><InlineReference kind="external" href={FIRST_RUN_GUIDE_URL} iconSrc={faviconSrc(FIRST_RUN_GUIDE_URL)}>{copy.learnMore}</InlineReference></Typo.Caption>
          </Inline>
          <MemoryModelStatus model={readiness.memory_model} language={flow.language} retry={flow.retryPreparation} />
        </>}
      </Stack>
    </SetupWizardContent>
  );
}

function FirstRunCancel({ flow }: { flow: FirstRunFlow }) {
  return <Button size="lg" stretch type="button" variant="ghost" onClick={flow.cancel}>{flow.copy.cancel}</Button>;
}
