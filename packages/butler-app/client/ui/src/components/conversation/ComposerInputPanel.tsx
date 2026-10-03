import { ComposerQuestionPanel } from "@/butler-ds";
import type { ComposerInputMode } from "./ComposerInputSurface";
import { ComposerPlanDecisionSurface } from "./ComposerPlanDecisionSurface";
import { ComposerAuthorityDecisionSurface } from "./ComposerAuthorityDecisionSurface";

export function ComposerInputPanel({ authorityDecision, question, planDecision }: ComposerInputMode) {
  if (authorityDecision && !authorityDecision.composingMessage) return <ComposerAuthorityDecisionSurface decision={authorityDecision} />;
  if (!authorityDecision && question) return <ComposerQuestionPanel key={question.key} {...question.panel} />;
  if (!authorityDecision && !question && planDecision && !planDecision.editingInstruction) return <ComposerPlanDecisionSurface decision={planDecision} />;
  return null;
}

