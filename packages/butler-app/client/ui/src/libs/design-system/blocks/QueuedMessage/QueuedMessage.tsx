import { useId, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject, ReactNode, Ref } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { AlertCircle, Clock3, PencilLine, Trash2 } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { useSendFlight } from "../../lib/sendFlight";
import styles from "./QueuedMessage.module.css";

export type QueuedMessageTone = "queued" | "sending" | "failed";

export interface QueuedMessageProps {
  /** The queued text, optionally with an attachment summary line. */
  children: ReactNode;
  /** Status label above the bubble, e.g. "Queued · 2 of 3". */
  status: ReactNode;
  /** queued: waiting; sending: send now requested (controls disabled); failed: send failed. */
  tone?: QueuedMessageTone;
  editLabel: string;
  onEdit: () => void;
  deleteLabel: string;
  onDelete: () => void;
  /** Long text clamps to five lines behind this toggle (as a sent user message does). */
  showMoreLabel?: string;
  showLessLabel?: string;
  /** Offered only for the message that would be sent next. */
  sendNowLabel?: string;
  sendNowHint?: string;
  onSendNow?: () => void;
  /** Just queued: flies in from the composer (send flight) or fades in. */
  entering?: boolean;
  ariaLabel?: string;
  /** Virtual list placement: vertical offset and measurement ref. */
  offsetY?: number;
  rowRef?: Ref<HTMLElement>;
  index?: number;
  dataTestClass?: string;
}

function assignRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else (ref as MutableRefObject<HTMLElement | null>).current = node;
}

export function QueuedMessage({
  children,
  status,
  tone = "queued",
  editLabel,
  onEdit,
  deleteLabel,
  onDelete,
  sendNowLabel,
  sendNowHint,
  onSendNow,
  showMoreLabel,
  showLessLabel,
  entering = false,
  ariaLabel,
  offsetY,
  rowRef,
  index,
  dataTestClass = "queued-message",
}: QueuedMessageProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const flying = useSendFlight(bubbleRef, entering);
  const busy = tone === "sending";
  const sendNow = onSendNow && sendNowLabel ? (
    <Button size="xs" variant="borderless" onClick={onSendNow} disabled={busy} data-test-class="queued-message-send-now">
      {sendNowLabel}
    </Button>
  ) : null;

  return (
    <article
      className={styles.row}
      aria-label={ariaLabel}
      data-test-class={dataTestClass}
      data-tone={tone}
      data-enter={entering ? (flying ? "fly" : "true") : undefined}
      data-index={index}
      ref={(node) => assignRef(rowRef, node)}
      style={offsetY === undefined ? undefined : { transform: `translateY(${offsetY}px)` }}
    >
      <Typo.Caption as="div" tone={tone === "failed" ? "danger" : "secondary"} className={styles.status}>
        {tone === "failed" ? <AlertCircle size="sm" /> : <Clock3 size="sm" />}
        <span>{status}</span>
      </Typo.Caption>
      <div className={styles.bubble} data-test-class="queued-message-bubble" ref={bubbleRef}>
        <ClampedText showMoreLabel={showMoreLabel} showLessLabel={showLessLabel}>{children}</ClampedText>
      </div>
      <div className={styles.controls}>
        {sendNow && sendNowHint ? <Tooltip label={sendNowHint}>{sendNow}</Tooltip> : sendNow}
        <IconButton label={editLabel} onClick={onEdit} disabled={busy}>
          <PencilLine size="sm" />
        </IconButton>
        <IconButton label={deleteLabel} onClick={onDelete} disabled={busy}>
          <Trash2 size="sm" />
        </IconButton>
      </div>
    </article>
  );
}

const CLAMP_LINES = 5;

function ClampedText({ children, showMoreLabel, showLessLabel }: {
  children: ReactNode;
  showMoreLabel?: string;
  showLessLabel?: string;
}) {
  const id = useId();
  const textRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clamp = Boolean(showMoreLabel && showLessLabel);
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!clamp || !node) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(node).lineHeight);
      setOverflowing(node.scrollHeight > lineHeight * CLAMP_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [clamp, children]);
  return (
    <>
      <div id={id} ref={textRef} className={styles.text} data-test-class="queued-message-text"
        data-clamped={clamp ? String(!expanded) : undefined}>
        {children}
      </div>
      {clamp && overflowing ? (
        <Button type="button" variant="inline" aria-controls={id} aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}>
          {expanded ? showLessLabel : showMoreLabel}
        </Button>
      ) : null}
    </>
  );
}
