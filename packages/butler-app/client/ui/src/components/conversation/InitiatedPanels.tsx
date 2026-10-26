import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { initiatedAction } from "@/app/initiatedAction";
import type { InitiatedOrigin, PatternCandidate, PatternProposalPanel, SchedulePausePanel } from "@/app/initiatedTypes";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import { Button, ButtonContainer, Clock3, ComposerDecisionPanel, Clickable, Stack, Typo } from "@/butler-ds";
import { patternMeta } from "../settings/hooks/usePatterns";

export function InitiatedPanels({ origin }: { origin?: InitiatedOrigin }) {
  const panel = origin?.panel;
  if (panel?.kind === "pattern_proposal") return panel.candidates.map(candidate =>
    <Proposal key={candidate.pattern_id} panel={panel} candidate={candidate} />);
  if (panel?.kind === "schedule_pause") return <Pause panel={panel} />;
  return null;
}

function openSchedule(id?: string) {
  const store = useButlerStore.getState();
  if (id) store.setView({ kind: "automation-detail", automationId: id });
  else store.openSettings("memory");
}

function useDecision() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  return { busy, run: async (action: () => Promise<unknown>, refresh?: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await action(); }
    catch (error) {
      const conflict = (error as { status?: number }).status === 409;
      if (conflict) await refresh?.().catch(() => undefined);
      notifyStatus(conflict ? appCopy.conversation.initiated.alreadyHandled : appCopy.conversation.initiated.failed, { tone: "error" });
    } finally { inFlight.current = false; setBusy(false); }
  } };
}

function DecisionActions({ busy, onDecide }: { busy: boolean; onDecide: (accept: boolean) => void }) {
  const copy = appCopy.conversation.initiated;
  return <ButtonContainer size="sm" justify="end">
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(false)}>{copy.noThanks}</Button>
    <Button size="sm" disabled={busy} onClick={() => onDecide(true)}>{copy.soundsGood}</Button>
  </ButtonContainer>;
}

function Proposal({ panel, candidate }: { panel: PatternProposalPanel; candidate: PatternCandidate }) {
  useAppLocale();
  const timezone = useButlerStore(state => state.settings.timezone);
  const [next, setNext] = useState<string>();
  const decision = useDecision();
  const copy = appCopy.conversation.initiated;
  useEffect(() => {
    let alive = true;
    setNext(undefined);
    if (candidate.state === "accepted" && candidate.automation_id) {
      void api<{ automation: { next_run_at?: string } }>(`/automations/${encodeURIComponent(candidate.automation_id)}`)
        .then(value => { if (alive) setNext(value.automation.next_run_at); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [candidate.state, candidate.automation_id]);
  const revision = () => api<{ revision: number }>("/memory/pattern-proposals");
  const decide = (accept: boolean) => { void decision.run(async () => {
    const view = await revision();
    await api(`/memory/pattern-proposals/${encodeURIComponent(panel.bundle_id)}`, { method: "POST", body: JSON.stringify({
      pattern_id: candidate.pattern_id, decision: accept ? "accepted" : "declined", expected_revision: view.revision,
    }) });
  }, () => useButlerStore.getState().refreshSessionView("general")); };
  const action = initiatedAction(candidate.action.title, candidate.action.schedule, timezone, candidate.state !== "accepted" || Boolean(next), next);
  if (candidate.state !== "pending") return <SettledSuggestion
    text={candidate.state === "accepted" ? copy.created(action) : copy.skipped(action)}
    automationId={candidate.state === "accepted" ? candidate.automation_id : undefined} />;
  return <ComposerDecisionPanel placement="conversation" icon={<Clock3 size="lg" />} data-test-class="initiated-proposal"
    title={action} details={[candidate.title, patternMeta({ ...candidate, id: candidate.pattern_id })]}
    onOpen={() => openSchedule()}
    actions={<DecisionActions busy={decision.busy} onDecide={decide} />} />;
}

function Pause({ panel }: { panel: SchedulePausePanel }) {
  useAppLocale();
  const timezone = useButlerStore(state => state.settings.timezone);
  const decision = useDecision();
  const copy = appCopy.conversation.initiated;
  const decide = (accept: boolean) => { void decision.run(() => api(`/automations/${encodeURIComponent(panel.automation_id)}/report-pause`, {
    method: "POST", body: JSON.stringify({ decision: accept ? "continue" : "stop" }),
  })); };
  const action = initiatedAction(panel.title, panel.schedule, timezone, false);
  if (panel.state !== "pending") return <SettledSuggestion
    text={panel.state === "continued" ? copy.continuing(action) : copy.paused(action)} automationId={panel.automation_id} />;
  return <ComposerDecisionPanel placement="conversation" icon={<Clock3 size="lg" />} data-test-class="initiated-pause"
    title={action} details={[copy.unopened(panel.unopened_count)]} onOpen={() => openSchedule(panel.automation_id)}
    actions={<DecisionActions busy={decision.busy} onDecide={decide} />} />;
}

function SettledSuggestion({ text, automationId }: { text: string; automationId?: string }) {
  const caption = <Typo.Caption as="span" tone="secondary" wrap="anywhere">{text}</Typo.Caption>;
  return <Stack gap="none" data-test-class="initiated-resolution">
    {automationId ? <Clickable variant="text" onClick={() => openSchedule(automationId)}>{caption}</Clickable> : caption}
  </Stack>;
}
