import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  MessageRecord,
  PlanDecisionAction,
  PlanDecisionResultView,
} from "@/app/types.ts";
import { ComposerPlanDecisionForm } from "@/butler-ds";
import { useComposerStore } from "./composerStore";

const PENDING_PLAN_STATUS = /(?:draft|pending|awaiting)/iu;

export function latestPendingPlan(messages: MessageRecord[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const plan = messages[index]?.plan_document;
    if (plan) return PENDING_PLAN_STATUS.test(plan.status) ? plan : null;
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

export function PlanDecisionNotice() {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const plan = useButlerStore((state) => latestPendingPlan(state.messages));
  const submitDecision = useButlerStore((state) => state.submitPlanDecision);
  const applyServerPlanMode = useComposerStore(
    (state) => state.applyServerPlanMode,
  );
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);

  if (!plan) return null;
  const decide = async (action: PlanDecisionAction) => {
    if (pending || (action === "instruct" && !instruction.trim())) return;
    setPending(true);
    const applied = await submitProjectedPlanDecision({
      action,
      activeChatId,
      applyPlanMode: applyServerPlanMode,
      instruction,
      planId: plan.id,
      submit: submitDecision,
    });
    setPending(false);
    if (applied && action === "instruct") setInstruction("");
  };

  return (
    <ComposerPlanDecisionForm
      acceptLabel={appCopy.composer.planAccept}
      ariaLabel={appCopy.composer.planDecision}
      instruction={instruction}
      instructionLabel={appCopy.composer.planInstruction}
      instructionPlaceholder={appCopy.composer.planInstructionPlaceholder}
      pending={pending}
      rejectLabel={appCopy.composer.planReject}
      submitLabel={appCopy.composer.planInstructionSubmit}
      onAccept={() => void decide("accept")}
      onInstructionChange={setInstruction}
      onReject={() => void decide("reject")}
      onSubmitInstruction={() => void decide("instruct")}
    />
  );
}
