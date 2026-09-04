import { useState } from "react";
import type { FormEvent } from "react";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  MessageRecord,
  PlanDocumentRecord,
  PlanDecisionAction,
  PlanDecisionResultView,
} from "@/app/types.ts";
import { useComposerStore } from "./composerStore";

const PENDING_PLAN_STATUS = /(?:draft|pending|awaiting)/iu;

export function latestActionablePlan(messages: MessageRecord[]): PlanDocumentRecord | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const plan = message.plan_document;
    return plan && PENDING_PLAN_STATUS.test(plan.status) ? plan : null;
  }
  return null;
}

export async function submitProjectedPlanDecision(input: {
  action: PlanDecisionAction;
  activeChatId: string;
  planId: string;
  instruction?: string;
  submit: (
    sessionId: string,
    planId: string,
    action: PlanDecisionAction,
    instruction?: string,
  ) => Promise<PlanDecisionResultView | null>;
  applyPlanMode: (enabled: boolean) => void;
}): Promise<boolean> {
  const instruction =
    input.action === "instruct" ? input.instruction?.trim() : undefined;
  if (input.action === "instruct" && !instruction) return false;
  const result = await input.submit(
    input.activeChatId,
    input.planId,
    input.action,
    instruction,
  );
  if (!result || result.controls.session_id !== input.activeChatId)
    return false;
  input.applyPlanMode(result.controls.controls.plan_mode);
  return true;
}

export interface ComposerPlanDecision {
  editingInstruction: boolean;
  instructionPlaceholder: string;
  pending: boolean;
  planTitle: string;
  onAccept: () => void;
  onOpenInstruction: () => void;
  onReject: () => void;
  onSubmitInstruction: (event: FormEvent<HTMLFormElement>) => void;
}

export function useComposerPlanDecision(): ComposerPlanDecision | undefined {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const plan = useButlerStore((state) => latestActionablePlan(state.messages));
  const planQueued = useButlerStore((state) =>
    Boolean(
      plan &&
      state.sessionQueue.some(
        (message) =>
          message.plan_id === plan.id &&
          (message.state === "queued" || message.state === "dispatching"),
      ),
    ),
  );
  const activeTurn = useButlerStore((state) =>
    Boolean(
      state.summary?.turn_state &&
      ACTIVE_TURN_STATES.has(state.summary.turn_state),
    ),
  );
  const submitDecision = useButlerStore((state) => state.submitPlanDecision);
  const planMode = useComposerStore((state) => state.planMode);
  const text = useComposerStore((state) => state.text);
  const setText = useComposerStore((state) => state.setText);
  const setEngaged = useComposerStore((state) => state.setEngaged);
  const textAreaRef = useComposerStore((state) => state.textAreaRef);
  const applyServerPlanMode = useComposerStore(
    (state) => state.applyServerPlanMode,
  );
  const [pending, setPending] = useState(false);
  const [instructionPlanId, setInstructionPlanId] = useState<string | null>(null);

  if (!planMode || !plan || planQueued || activeTurn) return undefined;

  const decide = async (action: PlanDecisionAction) => {
    if (action === "instruct" && !text.trim()) return;
    setPending(true);
    const applied = await submitProjectedPlanDecision({
      action,
      activeChatId,
      applyPlanMode: applyServerPlanMode,
      instruction: text,
      planId: plan.id,
      submit: submitDecision,
    });
    if (applied && action === "instruct") {
      setText("");
      setInstructionPlanId(null);
    }
    setPending(false);
  };

  return {
    editingInstruction: instructionPlanId === plan.id,
    instructionPlaceholder: appCopy.composer.planInstructionPlaceholder,
    pending,
    planTitle: plan.title,
    onAccept: () => void decide("accept"),
    onOpenInstruction: () => {
      setInstructionPlanId(plan.id);
      setEngaged(true);
      window.requestAnimationFrame(() => textAreaRef?.current?.focus({ preventScroll: true }));
    },
    onReject: () => void decide("reject"),
    onSubmitInstruction: (event) => {
      event.preventDefault();
      void decide("instruct");
    },
  };
}
