import { faviconSrc } from "@/app/favicons.ts";
import { Fragment } from "react";
import {
  AlertCircle, GitBranch, IconSlot, Monitor, Notice, ShieldCheck, SetupWizardStepAction,
  SendHorizontal, Separator, Stack, Terminal, InlineReference, Typo,
} from "@/butler-ds";
import { FIRST_RUN_GUIDE_URL } from "./FirstRunWelcome";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

const ITEM_ICONS = [GitBranch, Terminal, SendHorizontal, Monitor];

/** The required agreement, in the shell's single scrolling region. */
export function FirstRunConsent({ flow }: { flow: FirstRunFlow }) {
  const { copy, savingConsent } = flow;
  const blocked = flow.readiness.status === "failed";
  return (
    <FirstRunStepCard flow={flow} icon={<ShieldCheck size="lg" />} title={copy.consentTitle} titleId="first-run-consent-title"
      onBack={flow.mode === "consent" ? undefined : flow.backToWelcome}
      footerStart={<FirstRunPrepStatus flow={flow} />}
      actions={<>
        <SetupWizardStepAction disabled={savingConsent} onClick={flow.decline}>{copy.decline}</SetupWizardStepAction>
        <SetupWizardStepAction forward disabled={blocked || savingConsent} title={blocked ? copy.agreeBlocked : undefined} onClick={flow.agree}>{copy.agree}</SetupWizardStepAction>
      </>}
    >
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
                    <Typo.Body as="span"><InlineReference kind="external" href={`${FIRST_RUN_GUIDE_URL}#ai-providers`} iconSrc={faviconSrc(FIRST_RUN_GUIDE_URL)}>{copy.consentProviderLink}</InlineReference></Typo.Body>
                  ) : null}
                </Stack>
              </Stack>
            </Fragment>
          );
        })}
      </Stack>
      <Notice icon={<AlertCircle size="md" />} message={copy.consentClause} tone="warning" />
    </FirstRunStepCard>
  );
}
