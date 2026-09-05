import type { RefObject } from "react";
import { ComposerCardExpandedBody } from "@/butler-ds";
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
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
  planDecision?: ComposerPlanDecision;
  authorityDecision?: ComposerAuthorityDecision;
}) {
  if (authorityDecision && !authorityDecision.composingMessage) {
    return <ComposerAuthorityDecisionSurface decision={authorityDecision} />;
  }
  if (!authorityDecision && planDecision && !planDecision.editingInstruction) {
    return <ComposerPlanDecisionSurface decision={planDecision} />;
  }
  return (
    <>
      <ComposerCardExpandedBody>
        {authorityDecision ? (
          <ComposerDecisionAttachment title={authorityDecision.title} label={`허용 대기 ${authorityDecision.pendingCount}개`} onShowDecision={authorityDecision.onShowDecision} />
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
