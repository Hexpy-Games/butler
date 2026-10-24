import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { acknowledgeChatGptNotice } from "@/app/setupSignIn";
import { ManageChatGptUsage } from "../chatgpt/ChatGptPlanUsage";
import { KeyValueRow, SetupWizardStepAction, Stack, Typo } from "@/butler-ds";
import { SUPPORTED_UI_LANGUAGES } from "@/app/firstRunSetup.ts";
import { FirstRunPrepStatus } from "./FirstRunPrepStatus";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

/** Finish: what was set up, then Start chatting (completion is written here). */
export function FirstRunReady({ flow }: { flow: FirstRunFlow }) {
  const { copy, commit, reply, imported } = flow;
  const [showPlanNotice, setShowPlanNotice] = useState(flow.chatgpt.account?.plan_notice_pending === true);
  useEffect(() => { if (flow.chatgpt.account?.plan_notice_pending) setShowPlanNotice(true); }, [flow.chatgpt.account?.plan_notice_pending]);
  useEffect(() => { if (showPlanNotice && commit.connected) void acknowledgeChatGptNotice("plan").then(flow.chatgpt.setAccount).catch(() => {}); }, [showPlanNotice, Boolean(commit.connected)]);
  const text = { ...copy, ...copy.import, ...copy.summary };
  if (!commit.connected) return (
    <FirstRunStepCard flow={flow} contentKey="finishing"
      title={copy.finishing} footerStart={<FirstRunPrepStatus flow={flow} />} />
  );
  const cardId = commit.connected.cardId;
  const name = copy.providerNames[cardId];
  // Rows only for what happened: no import (skipped or nothing added) means no row.
  const agents = flow.mode === "first-run" && imported.agents && imported.agents.instructions + imported.agents.servers > 0 ? imported.agents : null;
  return (
    <FirstRunStepCard flow={flow} contentKey="ready"
      title={text.doneTitle} description={text.doneBody} onBack={flow.backFromReady}
      actions={<SetupWizardStepAction forward disabled={reply.saving} onClick={reply.complete}>{copy.finish}</SetupWizardStepAction>}
    >
      {reply.failed ? <Typo.Caption role="alert" tone="danger">{copy.finishFailed}</Typo.Caption> : null}
      <Stack gap="sm">
        <KeyValueRow label={text.rowAi} value={cardId === "chatgpt" && flow.signIn.account ? `${name} · ${flow.signIn.account}` : name} />
        <KeyValueRow label={text.rowReply} value={SUPPORTED_UI_LANGUAGES.find(entry => entry.value === reply.value)?.label ?? "—"} />
        {agents ? <KeyValueRow label={text.rowAgents} value={text.agentCounts(agents.instructions, agents.servers)} /> : null}
      </Stack>
      {showPlanNotice ? <Stack align="row" cross="center" gap="sm" wrap><Typo.Caption>{appCopy.firstRun.planNotice}</Typo.Caption><ManageChatGptUsage /></Stack> : null}
    </FirstRunStepCard>
  );
}
