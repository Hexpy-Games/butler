import type { ReactNode, Ref, RefObject } from "react";
import { useState } from "react";
import { agentNoticeLabel } from "@/app/agentRuntime.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  Box,
  ButtonContainer,
  ComposerCard,
  ComposerCardExpandedBody,
  ComposerCardExpandedControls,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerQuestionPanel,
  ComposerSendButton,
  ScrollArea,
  Space,
  Stack,
} from "@/butler-ds";
import { ComposerAttachments } from "@/components/conversation/ComposerAttachments";
import { ComposerCompactPreview } from "@/components/conversation/ComposerCompactPreview";
import { ComposerFileInput } from "@/components/conversation/ComposerFileInput";
import { imageRefusalLabel } from "@/components/conversation/composerImagePolicy";
import { useComposerStore } from "@/components/conversation/composerStore";
import { ComposerTextArea } from "@/components/conversation/ComposerTextArea";
import composerStyles from "@/butler-ds/blocks/ComposerCard/ComposerCard.module.css";
import { AccessPill, AttachmentPill, ContextPill, ModelPill, PlanPill, WorkspacePill } from "./controls";
import { proposalAttachment } from "./fixture";

export type ComposerVariant = "split" | "cluster" | "row";

/** ComposerToolbar's send/stop branch, unchanged: the same DS button and the same conditions. */
function SendSlot() {
  useAppLocale();
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const canStop = useComposerStore((store) => store.canStop);
  const [blockedImage] = useComposerStore((store) => store.blockedAttachments).values();
  const onStop = useComposerStore((store) => store.onStop);
  const reconnecting = useButlerStore((store) => store.liveConnectionLost);
  const agentNotice = useButlerStore((store) => store.agentNotice);
  if (agentNotice) {
    return <ComposerSendButton busy={agentNotice === "restarting"} disabled aria-label={agentNoticeLabel(agentNotice)} title={agentNoticeLabel(agentNotice)} />;
  }
  if (reconnecting) {
    return <ComposerSendButton busy aria-label={appCopy.feedback.reconnectingShort} title={appCopy.feedback.reconnectingShort} />;
  }
  if ((isSending || activeTurn) && canStop && !canSend) {
    return <ComposerSendButton mode="stop" aria-label={appCopy.composer.stop} onClick={onStop} />;
  }
  return (
    <ComposerCardExpandedControls>
      <ComposerSendButton aria-label={appCopy.composer.send} disabled={!canSend}
        disabledReason={blockedImage ? imageRefusalLabel(blockedImage) : undefined} />
    </ComposerCardExpandedControls>
  );
}

/**
 * The relocated control row: the same six controls in the same order and grouping (left group,
 * spacer, context + model), each a glass pill, on one line. A DS horizontal ScrollArea keeps it on
 * one line at narrow widths; its edge fades follow the scroll position.
 */
function ControlRow({ variant, label }: { variant: ComposerVariant; label: string }) {
  useAppLocale();
  return (
    <ScrollArea orientation="x" dataSlot="composer-controls" dataTestClass="composer-controls">
      {/* xs above keeps focus rings and shadows inside the scroller; the extra sm below keeps the
          pills above ScrollArea's 10px unmasked scrollbar lane, so clipped pills fade fully. */}
      <Box paddingY="xs" grow>
        <Stack gap="none">
          <ButtonContainer size="sm" wrap={false} grow role="group" aria-label={label}>
            <AttachmentPill />
            <AccessPill />
            <WorkspacePill />
            <PlanPill />
            {variant === "cluster" ? null : <Box grow aria-hidden="true" />}
            <ContextPill />
            <ModelPill />
          </ButtonContainer>
          <Space size="sm" />
        </Stack>
      </Box>
    </ScrollArea>
  );
}

function InlineSendBody({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  // Send sits at the inline end of the input, bottom-aligned with the last text line. Folded, the
  // one-line preview keeps ComposerCardToolbar's folded geometry (hit target + 8px) and send centers on it.
  return (
    <Stack align="row" cross={expanded ? "end" : "center"} gap="none">
      <Stack grow minWidth="0" gap="none">{children}</Stack>
      <Box padding={expanded ? "sm" : "xs"} shrink={false}><SendSlot /></Box>
    </Stack>
  );
}

/** Mock-only text: the group label (a new i18n key in the implementation) and the question content. */
export interface ProposalComposerCopy {
  controls: string;
  questionHeader: string;
  questionText: string;
  questionOptions: [string, string];
}

export interface ProposalComposerProps {
  variant: ComposerVariant;
  copy: ProposalComposerCopy;
  expanded: boolean;
  question: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** The whole block (card + row): the wallpaper's content rect, like the real composer's containerRef. */
  blockRef?: Ref<HTMLDivElement>;
}

export function ProposalComposer({ variant, copy, expanded, question, fileInputRef, blockRef }: ProposalComposerProps) {
  useAppLocale();
  const submit = useComposerStore((state) => state.submit);
  const [questionState, setQuestionState] = useState<"open" | "collapsed">("open");
  const collapse = () => setQuestionState("collapsed");
  const editor = (
    <ComposerCardExpandedBody>
      <ComposerTextArea />
      <ComposerAttachments />
    </ComposerCardExpandedBody>
  );
  return (
    // The block shares ComposerCard's own `wrap` geometry (centered conversation width and the
    // `composer` container), which is what the DS `controls` slot gives the row in the implementation.
    <div className={composerStyles.wrap} data-proposal-variant={variant} ref={blockRef}>
      <Stack gap="xs">
        <ComposerCard large expanded={expanded || question} onSubmit={submit}>
          {question ? (
            <ComposerQuestionPanel
              key="proposal-question"
              labels={appCopy.interfaceDetails.questionPanel}
              questions={[{
                id: "destination", header: copy.questionHeader, text: copy.questionText, type: "single",
                options: [{ label: copy.questionOptions[0], recommended: true }, { label: copy.questionOptions[1] }],
              }]}
              state={questionState}
              onSubmit={collapse}
              onSkip={collapse}
              onCollapse={collapse}
              onExpand={() => setQuestionState("open")}
            />
          ) : null}
          {variant === "row" ? (
            <>
              {editor}
              <ComposerCardToolbar>
                <ComposerCompactPreview />
                <ComposerCardToolbarSpacer />
                <SendSlot />
              </ComposerCardToolbar>
            </>
          ) : (
            <InlineSendBody expanded={expanded || question}>
              {editor}
              {expanded || question ? null : <ComposerCardToolbar><ComposerCompactPreview /></ComposerCardToolbar>}
            </InlineSendBody>
          )}
          <ComposerFileInput inputRef={fileInputRef}
            onFiles={(files) => { if (files?.length) useComposerStore.setState({ attachments: [proposalAttachment] }); }} />
        </ComposerCard>
        <ControlRow variant={variant} label={copy.controls} />
      </Stack>
    </div>
  );
}
