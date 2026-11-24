import { useActiveCanonEpic } from "../canon/useActiveCanonEpic.ts";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
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
import { PendingInstructionCard, usePendingInstructions } from "./PendingInstructionCard";
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
  useAppLocale();
  const epic = useActiveCanonEpic();
  const { item, computerName, refresh, remove } = usePendingInstructions();
  if (authorityDecision && !authorityDecision.composingMessage) {
    return <ComposerAuthorityDecisionSurface decision={authorityDecision} />;
  }
  if (!authorityDecision && planDecision && !planDecision.editingInstruction) {
    return <ComposerPlanDecisionSurface decision={planDecision} />;
  }
  if (!authorityDecision && !planDecision && item) {
    return <PendingInstructionCard key={item.id} {...{ item, refresh, remove }}
      computerName={computerName ?? appCopy.computers.removedComputer} />;
  }
  return (
    <>
      <ComposerCardExpandedBody>
        {authorityDecision ? (
          <ComposerDecisionAttachment title={authorityDecision.title} label={appCopy.interfaceTemplates.pendingApprovals(authorityDecision.pendingCount)} onShowDecision={authorityDecision.onShowDecision} />
        ) : planDecision?.editingInstruction ? (
          <ComposerPlanInstructionContext decision={planDecision} />
        ) : null}
        <ComposerTextArea placeholder={authorityDecision ? undefined : planDecision?.instructionPlaceholder ?? (epic ? appCopy.canon.epicPlaceholder : undefined)} />
        <ComposerAttachments />
      </ComposerCardExpandedBody>
      <ComposerToolbar />
      <ComposerFileInput inputRef={fileInputRef} onFiles={onFiles} />
    </>
  );
}
