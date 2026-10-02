import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { RefObject } from "react";
import { ComposerQuestionPanel, type ComposerQuestionPanelProps, ComposerCardExpandedBody } from "@/butler-ds";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerFileInput } from "./ComposerFileInput";
import { ComposerTextArea } from "./ComposerTextArea";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";
import { ComposerPlanDecisionSurface } from "./ComposerPlanDecisionSurface";
import { ComposerPlanInstructionContext } from "./ComposerPlanInstructionContext";
import { ComposerAuthorityDecisionSurface } from "./ComposerAuthorityDecisionSurface";
import { ComposerDecisionAttachment } from "./ComposerDecisionAttachment";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";

export function ComposerInputSurface({
  fileInputRef,
  onFiles,
  planDecision,
  authorityDecision,
  question,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
  planDecision?: ComposerPlanDecision;
  authorityDecision?: ComposerAuthorityDecision;
  question?: { key: string; panel: ComposerQuestionPanelProps };
}) {
  useAppLocale();
  if (authorityDecision && !authorityDecision.composingMessage) {
    return <ComposerAuthorityDecisionSurface decision={authorityDecision} />;
  }
  if (!authorityDecision && question && question.panel.state !== "collapsed") return <ComposerQuestionPanel key={question.key} {...question.panel} />;
  if (!authorityDecision && !question && planDecision && !planDecision.editingInstruction) {
    return <ComposerPlanDecisionSurface decision={planDecision} />;
  }
  return (
    <>
      {!authorityDecision && question && <ComposerQuestionPanel key={question.key} {...question.panel} />}
      <ComposerCardExpandedBody>
        {authorityDecision ? (
          <ComposerDecisionAttachment title={authorityDecision.title} label={appCopy.interfaceTemplates.pendingApprovals(authorityDecision.pendingCount)} onShowDecision={authorityDecision.onShowDecision} />
        ) : planDecision?.editingInstruction ? (
          <ComposerPlanInstructionContext decision={planDecision} />
        ) : null}
        <ComposerTextArea placeholder={authorityDecision ? undefined : planDecision?.instructionPlaceholder} />
        <ComposerAttachments />
      </ComposerCardExpandedBody>
      <ComposerToolbar />
      <ComposerFileInput inputRef={fileInputRef} onFiles={onFiles} />
    </>
  );
}
