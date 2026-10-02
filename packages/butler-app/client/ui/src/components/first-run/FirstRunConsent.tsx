import { Fragment, useEffect } from "react";
import {
  AlertCircle, Button, ButtonContainer, GitBranch, IconSlot, Monitor, Notice,
  SendHorizontal, Separator, SetupWizardContent, Stack, Terminal, Typo,
} from "@/butler-ds";
import { FIRST_RUN_GUIDE_URL } from "./FirstRunWelcome";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import type { FirstRunFlow } from "./useFirstRunFlow";

const ITEM_ICONS = [GitBranch, Terminal, SendHorizontal, Monitor];

/** The required agreement, in the shell's single scrolling region. */
export function FirstRunConsent({ flow }: { flow: FirstRunFlow }) {
  const { copy, savingConsent } = flow;
  const blocked = flow.readiness.status === "failed";
  useEffect(() => {
    document.getElementById("first-run-consent-title")?.focus();
  }, []);
  return (
    <SetupWizardContent width="wide" surface="solid">
      <Typo.H3 as="h1" id="first-run-consent-title" tabIndex={-1}>{copy.consentTitle}</Typo.H3>
      <Stack aria-labelledby="first-run-consent-title" gap="sm" role="list">
        {copy.consentItems.map((item, index) => {
          const Icon = ITEM_ICONS[index];
          return (
            <Fragment key={index}>
              {index > 0 ? <Separator /> : null}
              <Stack align="row" cross="start" gap="md" role="listitem">
                <IconSlot size="md" minHeight="line" aria-hidden="true"><Icon size="md" /></IconSlot>
                <Stack gap="xs">
                  <Typo.Body>{item.body}</Typo.Body>
                  {item.caption ? <Typo.Caption tone="secondary">{item.caption}</Typo.Caption> : null}
                  {index === 2 ? (
                    <Button asChild size="sm" variant="link">
                      <a href={`${FIRST_RUN_GUIDE_URL}#ai-providers`} rel="noreferrer" target="_blank">
                        <Typo.Text as="span" wrap="normal">{copy.consentProviderLink}</Typo.Text>
                      </a>
                    </Button>
                  ) : null}
                </Stack>
              </Stack>
            </Fragment>
          );
        })}
      </Stack>
      <Notice icon={<AlertCircle size="md" />} message={copy.consentClause} tone="warning" />
      <ButtonContainer justify="end" size="lg">
        <Button disabled={savingConsent} size="lg" type="button" variant="outline" onClick={flow.decline}>{copy.decline}</Button>
        <Button disabled={blocked || savingConsent} size="lg" title={blocked ? copy.agreeBlocked : undefined} type="button" onClick={flow.agree}>{copy.agree}</Button>
      </ButtonContainer>
      {blocked ? <FirstRunPrepStatus flow={flow} /> : null}
    </SetupWizardContent>
  );
}
