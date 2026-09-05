import type { RefObject, KeyboardEventHandler } from "react";
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
  onAuthorityKeyDown,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList | null) => void;
  planDecision?: ComposerPlanDecision;
  authorityDecision?: ComposerAuthorityDecision;
  onAuthorityKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
}) {
  const instruction = authorityDecision?.editingInstruction ? authorityDecision : undefined;
  if (authorityDecision && !instruction && !authorityDecision.composingMessage) {
    return <ComposerAuthorityDecisionSurface decision={authorityDecision} />;
  }
  if (!authorityDecision && planDecision && !planDecision.editingInstruction) {
    return <ComposerPlanDecisionSurface decision={planDecision} />;
  }
  return (
    <>
      <ComposerCardExpandedBody>
        {authorityDecision ? (
          <ComposerDecisionAttachment title={authorityDecision.title} label={instruction ? "요청 수정 중" : `허용 대기 ${authorityDecision.pendingCount}개`} onShowDecision={authorityDecision.onShowDecision} />
        ) : planDecision?.editingInstruction ? (
          <ComposerPlanInstructionContext decision={planDecision} />
        ) : null}
        <ComposerTextArea placeholder={instruction ? "변경할 내용을 입력해 주세요" : authorityDecision ? undefined : planDecision?.instructionPlaceholder}
          input={instruction ? { value: instruction.instruction, onChange: instruction.setInstruction, onKeyDown: onAuthorityKeyDown } : undefined} />
        {!instruction ? <ComposerAttachments /> : null}
      </ComposerCardExpandedBody>
      <ComposerToolbar decisionInput={instruction ? { canSend: Boolean(instruction.instruction.trim()) && !instruction.pending } : undefined} />
      <ComposerFileInput inputRef={fileInputRef} onFiles={onFiles} />
    </>
  );
}
