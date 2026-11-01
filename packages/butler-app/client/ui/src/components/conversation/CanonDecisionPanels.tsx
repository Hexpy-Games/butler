import { useState } from "react";
import { decideCanonHold, takeCanonHere } from "@/app/canonQueue.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Button, ButtonContainer, CircleAlert, ComposerDecisionPanel, Typo } from "@/butler-ds";
import type { CanonHoldPanel, CanonTakeHerePanel } from "../../../../shared/canon-queue-contracts.ts";
import { useDecision } from "./useInitiatedDecision.ts";

type Complete = (action: () => void) => void;

export function CanonHold({ panel }: { panel: CanonHoldPanel }) {
  useAppLocale();
  const decision = useDecision();
  const [state, setState] = useStateForPanel(panel);
  const copy = appCopy.canon.queue;
  const decide = (proceed: boolean, complete: Complete) => { void decision.run(async () => {
    await decideCanonHold(panel.session_id, panel.epic_id, proceed ? "continue" : "delete");
    complete(() => setState(proceed ? "continued" : "deleted"));
  }, () => useButlerStore.getState().refreshSessionView(panel.session_id)); };
  if (state !== "pending") return <Typo.Caption tone="secondary" data-test-class="canon-hold-settled">{state === "deleted" ? copy.removed : state === "resolved" ? copy.resolved : copy.continued}</Typo.Caption>;
  return <ComposerDecisionPanel placement="conversation" icon={<CircleAlert size="lg" />} title={panel.epic_title}
    data-test-class="canon-hold" onOpen={() => useButlerStore.getState().openSession(panel.session_id)} actions={complete => <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="secondary" disabled={decision.busy} onClick={() => decide(false, complete)}>{copy.remove}</Button>
      <Button size="sm" disabled={decision.busy} onClick={() => decide(true, complete)}>{copy.proceed}</Button>
    </ButtonContainer>} />;
}
export function CanonTakeHere({ panel }: { panel: CanonTakeHerePanel }) {
  useAppLocale();
  const decision = useDecision();
  const [state, setState] = useStateForPanel(panel);
  const copy = appCopy.canon.queue;
  const take = (complete: Complete) => { void decision.run(async () => {
    await takeCanonHere(panel.session_id, panel.epic_id);
    complete(() => setState("taken"));
  }, () => useButlerStore.getState().refreshSessionView(panel.session_id)); };
  if (state !== "pending") return <Typo.Caption tone="secondary" data-test-class="canon-take-settled">{copy.taken}</Typo.Caption>;
  return <ComposerDecisionPanel placement="conversation" icon={<CircleAlert size="lg" />} title={panel.epic_title}
    data-test-class="canon-take-here" onOpen={() => useButlerStore.getState().openSession(panel.other_session_id)} actions={complete => <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="secondary" onClick={() => useButlerStore.getState().openSession(panel.other_session_id)}>{copy.openOther}</Button>
      <Button size="sm" disabled={decision.busy} onClick={() => take(complete)}>{copy.take}</Button>
    </ButtonContainer>} />;
}

function useStateForPanel<T extends CanonHoldPanel | CanonTakeHerePanel>(panel: T) {
  const key = `${panel.session_id}:${panel.epic_id}:${panel.state}`;
  const [settled, setSettled] = useState({ key, state: panel.state });
  return [settled.key === key ? settled.state : panel.state,
    (state: T["state"]) => setSettled({ key, state })] as const;
}
