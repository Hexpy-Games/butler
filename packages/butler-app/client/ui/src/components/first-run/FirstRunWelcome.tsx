import type { ReactNode } from "react";
import {
  Button,
  ButtonContainer,
  ButlerThinkingMark,
  IconTile,
  Inline,
  NativeSelect,
  NativeSelectOption,
  SendHorizontal,
  Separator,
  ShieldCheck,
  Monitor,
  SetupWizardContent,
  Stack,
  TintedGlass,
  Typo,
} from "@/butler-ds";
import type { FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Opens the Butler user manual's first-run page in the system browser. */
export const FIRST_RUN_GUIDE_URL = "https://hexpy-games.github.io/butler/docs/getting-started/first-run/";

const CONSENT_ICONS: ReactNode[] = [<ShieldCheck key="asks" size="md" />, <SendHorizontal key="sends" size="md" />, <Monitor key="stays" size="md" />];

/** Welcome and consent: three plain lines, one button, preparation in the background. */
export function FirstRunWelcome({ flow }: { flow: FirstRunFlow }) {
  const { copy, readiness } = flow;
  const blocked = readiness.status === "failed";
  return (
    <SetupWizardContent>
      <Stack cross="center" gap="md">
        <IconTile size="xl" tone="plain">
          <ButlerThinkingMark state={readiness.status === "preparing" ? "working" : "idle"} />
        </IconTile>
        <Typo.H3 align="center" as="h1">{copy.welcomeTitle}</Typo.H3>
        <Typo.Body align="center" tone="secondary">{copy.welcomeLede}</Typo.Body>
      </Stack>
      <Inline justify="between">
        <Inline gap="sm" wrap={false}>
          <Typo.Caption as="label" htmlFor="first-run-language" tone="tertiary">{flow.language === "ko" ? "인터페이스 언어" : "Interface language"}</Typo.Caption>
          <NativeSelect
            id="first-run-language"
            size="sm"
            value={flow.language}
            onChange={(event) => flow.setLanguage(event.target.value as FirstRunLanguage)}
          >
            <NativeSelectOption value="ko">한국어</NativeSelectOption>
            <NativeSelectOption value="en">English</NativeSelectOption>
          </NativeSelect>
        </Inline>
        <Button asChild size="sm" variant="link">
          <a href={FIRST_RUN_GUIDE_URL} rel="noreferrer" target="_blank">{copy.learnMore}</a>
        </Button>
      </Inline>
      <TintedGlass padding="sm" radius="panel">
        <Stack aria-label={copy.welcomeTitle} gap="sm" role="list">
          {copy.consent.map((item, index) => (
            <Stack gap="sm" key={item.title} role="listitem">
              {index > 0 ? <Separator /> : null}
              <Stack align="row" cross="start" gap="md">
                <IconTile size="sm" tone="accent">{CONSENT_ICONS[index]}</IconTile>
                <Stack gap="none">
                  <Typo.Label as="span" weight="semibold">{item.title}</Typo.Label>
                  <Typo.Caption tone="secondary">{item.body}</Typo.Caption>
                </Stack>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </TintedGlass>
      <Stack gap="sm">
        <ButtonContainer size="lg">
          <Button
            disabled={blocked || flow.savingConsent}
            size="lg"
            stretch
            title={blocked ? copy.agreeBlocked : undefined}
            type="button"
            onClick={flow.agree}
          >
            {copy.agree}
          </Button>
          {flow.mode === "rerun" ? <FirstRunCancel flow={flow} /> : null}
        </ButtonContainer>
        <FirstRunPrepStatus flow={flow} />
      </Stack>
    </SetupWizardContent>
  );
}

function FirstRunCancel({ flow }: { flow: FirstRunFlow }) {
  return <Button size="lg" type="button" variant="ghost" onClick={flow.cancel}>{flow.copy.cancel}</Button>;
}
