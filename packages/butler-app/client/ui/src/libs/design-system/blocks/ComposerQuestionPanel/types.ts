import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes } from "react";

export interface ComposerQuestion {
  id: string;
  header: string;
  text: string;
  type: "single" | "multi" | "text";
  options: readonly { label: string; description?: string; recommended?: boolean }[];
  allowOther?: boolean;
  placeholder?: string;
}
export interface QuestionAnswer {
  id: string;
  selected: readonly number[];
  text: string;
  other: string;
  skipped: boolean;
}
export type QuestionPanelState = "open" | "submitting" | "error" | "collapsed" | "working";
export interface QuestionPanelLabels {
  review: string; send: string; next: string; back: string; skip: string;
  skipped: string; later: string; pending: string; other: string;
  recommended: string; working: string; select: string;
}
export const questionPanelLabels: QuestionPanelLabels = {
  review: "Review", send: "Send", next: "Next", back: "Back", skip: "Skip",
  skipped: "Skipped", later: "Answer later", pending: "Answer pending", other: "Other…",
  recommended: "Recommended", working: "Working", select: "Select",
};
export interface ComposerQuestionPanelProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "onSubmit" | "children"> {
  questions: readonly ComposerQuestion[];
  onSubmit: (answers: readonly QuestionAnswer[]) => void;
  onSkip: () => void;
  onCollapse: () => void;
  onExpand?: () => void;
  /** Optional snapshot for restoring drafts when a caller remounts the surface. */
  onDraftChange?: (answers: readonly QuestionAnswer[], step: number) => void;
  state?: QuestionPanelState;
  error?: string;
  labels?: QuestionPanelLabels;
  defaultAnswers?: readonly QuestionAnswer[];
  defaultStep?: number;
}
export function answerText(question: ComposerQuestion, answer?: QuestionAnswer): string {
  if (!answer || answer.skipped) return "";
  return [...answer.selected.map((i) => question.options[i]?.label).filter(Boolean), answer.text.trim(), answer.other.trim()].filter(Boolean).join(", ");
}
