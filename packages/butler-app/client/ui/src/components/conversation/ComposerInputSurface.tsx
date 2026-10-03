import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { RefObject } from "react";
import { type ComposerQuestionPanelProps, ComposerCardExpandedBody } from "@/butler-ds";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerFileInput } from "./ComposerFileInput";
import { ComposerTextArea } from "./ComposerTextArea";
import { ComposerCompactPreview } from "./ComposerCompactPreview";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import { ComposerPlanInstructionContext } from "./ComposerPlanInstructionContext";
import { ComposerDecisionAttachment } from "./ComposerDecisionAttachment";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";

export interface ComposerInputMode {
  planDecision?: ComposerPlanDecision;
  authorityDecision?: ComposerAuthorityDecision;
  question?: { key: string; panel: ComposerQuestionPanelProps };
}

export function composerPanelActive({ authorityDecision, question, planDecision }: ComposerInputMode) {
  if (authorityDecision) return !authorityDecision.composingMessage;
  if (question) return question.panel.state !== "collapsed";
  return Boolean(planDecision && !planDecision.editingInstruction);
}

export function ComposerInputSurface({ fileInputRef, onFiles, planDecision, authorityDecision, question }: ComposerInputMode & {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
}) {
  useAppLocale();
  const activePanel = composerPanelActive({ planDecision, authorityDecision, question });
  const openDraft = authorityDecision?.onComposeMessage ?? question?.panel.onCollapse ?? planDecision?.onOpenInstruction;
  return <>
    <ComposerCardExpandedBody inactive={activePanel}>
      {authorityDecision ? (
        <ComposerDecisionAttachment title={authorityDecision.title} label={appCopy.interfaceTemplates.pendingApprovals(authorityDecision.pendingCount)} onShowDecision={authorityDecision.onShowDecision} />
      ) : planDecision?.editingInstruction ? <ComposerPlanInstructionContext decision={planDecision} /> : null}
      <ComposerTextArea placeholder={authorityDecision ? undefined : planDecision?.instructionPlaceholder} />
      <ComposerAttachments />
    </ComposerCardExpandedBody>
    <ComposerCompactPreview onExpand={activePanel ? openDraft : undefined} />
    <ComposerFileInput inputRef={fileInputRef} onFiles={onFiles} />
  </>;
}
