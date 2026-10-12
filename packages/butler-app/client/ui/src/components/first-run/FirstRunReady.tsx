import { KeyValueRow, SetupWizardStepAction, Stack, Typo } from "@/butler-ds";
import { SUPPORTED_UI_LANGUAGES } from "@/app/firstRunSetup.ts";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Finish: what was set up, then Start chatting (completion is written here). */
export function FirstRunReady({ flow }: { flow: FirstRunFlow }) {
  const { copy, commit, reply, imported } = flow;
  const text = { ...copy, ...copy.import, ...copy.summary };
  if (!commit.connected) return (
    <FirstRunStepCard flow={flow} contentKey="finishing"
      title={copy.finishing} footerStart={<FirstRunPrepStatus flow={flow} />} />
  );
  const cardId = commit.connected.cardId;
  const name = copy.providerNames[cardId];
  const agents = imported.agents ?? { instructions: 0, servers: 0 };
  const browsers = imported.browsers;
  return (
    <FirstRunStepCard flow={flow} contentKey="ready"
      title={text.doneTitle} description={text.doneBody} onBack={flow.backFromReady}
      actions={<SetupWizardStepAction forward disabled={reply.saving} onClick={reply.complete}>{copy.finish}</SetupWizardStepAction>}
    >
      {reply.failed ? <Typo.Caption role="alert" tone="danger">{copy.finishFailed}</Typo.Caption> : null}
      <Stack gap="sm">
        <KeyValueRow label={text.rowAi} value={cardId === "chatgpt" && flow.signIn.account ? `${name} · ${flow.signIn.account}` : name} />
        <KeyValueRow label={text.rowReply} value={SUPPORTED_UI_LANGUAGES.find(entry => entry.value === reply.value)?.label ?? "—"} />
        {flow.mode === "first-run" ? <KeyValueRow label={text.rowAgents} value={text.agentCounts(agents.instructions, agents.servers)} /> : null}
        {flow.mode === "first-run" ? <KeyValueRow label={text.rowBrowsers} value={text.browserCounts(browsers.bookmarks, browsers.passwords)} /> : null}
      </Stack>
    </FirstRunStepCard>
  );
}
