import type { ReactNode, Ref, RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import { agentNoticeLabel } from "@/app/agentRuntime.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  Box,
  ButtonContainer,
  ComposerCard,
  ComposerQuestionPanel,
  ComposerSendButton,
  ScrollArea,
  Space,
  Stack,
} from "@/butler-ds";
import { ComposerAttachments } from "@/components/conversation/ComposerAttachments";
import { ComposerFileInput } from "@/components/conversation/ComposerFileInput";
import { imageRefusalLabel } from "@/components/conversation/composerImagePolicy";
import { useComposerStore } from "@/components/conversation/composerStore";
import { ComposerTextArea } from "@/components/conversation/ComposerTextArea";
import composerStyles from "@/butler-ds/blocks/ComposerCard/ComposerCard.module.css";
import { AccessPill, AttachmentPill, ContextPill, ModelPill, PlanPill, WorkspacePill } from "./controls";
import { proposalAttachment } from "./fixture";

export type ComposerVariant = "split" | "cluster";

/** ComposerToolbar's send/stop branch: same DS button and conditions; the fold-only ExpandedControls wrapper is gone. */
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
    <ComposerSendButton aria-label={appCopy.composer.send} disabled={!canSend}
      disabledReason={blockedImage ? imageRefusalLabel(blockedImage) : undefined} />
  );
}

/**
 * The relocated control row: the same six controls in the same order and grouping (left group,
 * spacer, context + model), each a glass pill, on one line. A DS horizontal ScrollArea keeps it on
 * one line at narrow widths; its edge fades follow the scroll position.
 *
 * Edge alignment (inset 0): ScrollArea pads its content by the fade size (14px) on both inline sides. The
 * frame is made wider than the card by exactly that padding on each side (centered overflow), so at
 * rest the first pill starts on the card's start edge and the last pill ends on its end edge, and
 * the fades sit just outside the card. The implementation is a DS ScrollArea option (see spec).
 */
function ControlRow({ variant, label, inset }: { variant: ComposerVariant; label: string; inset: number }) {
  useAppLocale();
  // `inset` (review slider, 0-32px) moves both resting edges inward symmetrically.
  return (
    <Stack gap="none" UNSAFE_style={{ width: `calc(100% + 2 * var(--scroll-fade-size) - ${2 * inset}px)` }}>
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
  question: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** Control row inset from the card's start/end edges, px. */
  inset: number;
  /** The whole block (card + row): the wallpaper's content rect, like the real composer's containerRef. */
  blockRef?: Ref<HTMLDivElement>;
}

/** True when the card is in the `composer` container's compact range (<= 520px), like the DS CSS. */
function useCompactCard(): [(node: HTMLDivElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setCompact(node.clientWidth <= 520));
    observer.observe(node);
    setCompact(node.clientWidth <= 520);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, compact];
}

/**
 * Inline action: the editor and send/stop share one line. The send slot is exactly one editor line
 * tall (1.5em line + 12px block padding, the editor's own one-line height) and sits at the row's end,
 * so it centers on the last text line: idle the card is one line, and as text wraps the card grows
 * while send stays bottom-right on the last line. Its end inset is today's toolbar inset (8px, 4px
 * compact), so send keeps the product's size and end offset. Stand-in for the DS
 * `ComposerCardInlineAction` (see spec).
 */
function InlineAction({ compact, children }: { compact: boolean; children: ReactNode }) {
  return (
    <Stack align="row" cross="end" gap="none">
      <Stack grow minWidth="0" gap="none">{children}</Stack>
      <Box paddingX={compact ? "xs" : "sm"} shrink={false}>
        <Stack justify="center" cross="center" gap="none"
          UNSAFE_style={{ height: "calc(1.5em + var(--space-3) * 2)" }}>
          <SendSlot />
        </Stack>
      </Box>
    </Stack>
  );
}

/**
 * The card is the product composer card with the fold and the in-card toolbar row removed: the same
 * ComposerCard (radius, border, text inset, font), the question panel on top, then the editor line
 * with send/stop inline at its end, then attachments (today's order). Only the controls move out.
 */
export function ProposalComposer({ variant, copy, question, fileInputRef, blockRef, inset }: ProposalComposerProps) {
  useAppLocale();
  const submit = useComposerStore((state) => state.submit);
  const [questionState, setQuestionState] = useState<"open" | "collapsed">("open");
  const collapse = () => setQuestionState("collapsed");
  const [measureRef, compact] = useCompactCard();
  const setBlock = useCallback((node: HTMLDivElement | null) => {
    measureRef(node);
    if (typeof blockRef === "function") blockRef(node);
  }, [blockRef, measureRef]);
  return (
    // ComposerCard's own `wrap` + `large` geometry (centered conversation width, `composer`
    // container) around card + row: what the DS `controls` slot gives the row in the implementation.
    <div className={`${composerStyles.wrap} ${composerStyles.large}`} data-proposal-variant={variant} ref={setBlock}>
      <Stack gap="xs" cross="center">
        <ComposerCard large onSubmit={submit}>
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
          <InlineAction compact={compact}>
            <ComposerTextArea />
          </InlineAction>
          <ComposerAttachments />
          <ComposerFileInput inputRef={fileInputRef}
            onFiles={(files) => { if (files?.length) useComposerStore.setState({ attachments: [proposalAttachment] }); }} />
        </ComposerCard>
        <ControlRow variant={variant} label={copy.controls} inset={inset} />
      </Stack>
    </div>
  );
}
