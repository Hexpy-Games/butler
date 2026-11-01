import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import { BROWSER_CHAT_WIDTH, clampBrowserChatWidth } from "./conversationFrame";
import styles from "./AdaptiveShellFrame.module.css";
import { ResizeGrip, resizeHandleClassName } from "./ResizeGrip";
import { prefersReducedMotion } from "../../lib/motion";
import { SplitPaneMotion } from "./AdaptiveShellSplitMotion";

export interface AdaptiveShellSplitProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** The conversation column (left). It is its own `workspace` container, so it lays out at its width. */
  chat: ReactNode;
  /** The pane beside the chat (the browser, the file viewer, the image editor); shown while `paneOpen` and while it leaves. */
  pane?: ReactNode;
  paneOpen: boolean;
  /** What the split shows (a conversation id). When it changes the pane opens or closes at once, without motion. */
  contextKey?: string;
  /** Chat column width in px while the pane is open (340–560, default 400). */
  chatWidth?: number;
  /** Drag or keyboard resize of the chat column; already clamped. Omit to lock the width. */
  onChatWidthChange?: (width: number) => void;
  /** Accessible name of the resize handle ("Resize conversation"). */
  resizeLabel?: string;
  /** Second line of the handle's hover hint ("Drag to resize"), under `resizeLabel`; shown on the chat side. */
  resizeHint?: string;
}

const KEY_STEP = 16;

const PaneLeavingContext = createContext(false);

/**
 * What a pane reads from a store while it leaves: the value from before it started leaving. A close often empties the
 * store the pane renders from (the last file closed), and the pane stays on screen until its motion ends.
 */
export function useHeldWhilePaneLeaves<T>(value: T): T {
  const leaving = useContext(PaneLeavingContext);
  const held = useRef(value);
  useLayoutEffect(() => { if (!leaving) held.current = value; });
  return leaving ? held.current : value;
}

/**
 * The conversation frame's split slot inside AdaptiveShellWorkspace (below the titlebar): chat | browser
 * pane, the chat column resizable between 340 and 560px. Pass `splitOpen` to AdaptiveShell while the
 * pane is open: the inspector then stays closed (the two never show together). The pane opens and closes on one
 * motion (SplitPaneMotion), whatever it holds; a resize is immediate.
 */
export function AdaptiveShellSplit({
  chat, pane, paneOpen, contextKey, chatWidth = BROWSER_CHAT_WIDTH.default, onChatWidthChange, resizeLabel = "Resize conversation",
  resizeHint, className, style, ...props
}: AdaptiveShellSplitProps) {
  const width = clampBrowserChatWidth(chatWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const hintId = useId();
  const [split, setSplit] = useState<HTMLDivElement | null>(null);
  const motion = useRef<SplitPaneMotion>(null);
  // A closing pane stays mounted with the node it last had until its motion ends; reopening keeps it mounted.
  const lastPane = useRef(pane);
  useLayoutEffect(() => { if (paneOpen) lastPane.current = pane; });
  const [shown, setShown] = useState({ open: paneOpen, contextKey, leaving: false });
  if (shown.open !== paneOpen || shown.contextKey !== contextKey) {
    setShown({ open: paneOpen, contextKey, leaving: shown.open && !paneOpen && shown.contextKey === contextKey && !prefersReducedMotion() });
  }
  const present = paneOpen || shown.leaving;
  const resize = (next: number) => onChatWidthChange?.(clampBrowserChatWidth(next));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 3 : KEY_STEP;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: BROWSER_CHAT_WIDTH.min, End: BROWSER_CHAT_WIDTH.max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    motion.current?.settle();
    resize(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    motion.current?.settle();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
    event.currentTarget.toggleAttribute("data-dragging", true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    event.currentTarget.removeAttribute("data-dragging");
  };
  return (
    <div {...props} ref={setSplit} className={cn(styles.split, className)} data-slot="adaptive-shell-split" data-pane-open={present || undefined}
      data-pane-leaving={shown.leaving || undefined}
      style={{ ...style, "--browser-chat-width": `${width}px` } as CSSProperties}>
      <div className={styles.chat} data-slot="adaptive-shell-split-chat">{chat}</div>
      {present ? (
        <>
          <div inert={shown.leaving} className={cn(styles.splitHandle, resizeHandleClassName)} role="separator" aria-orientation="vertical" aria-label={resizeLabel}
            aria-describedby={resizeHint ? hintId : undefined}
            aria-valuemin={BROWSER_CHAT_WIDTH.min} aria-valuemax={BROWSER_CHAT_WIDTH.max} aria-valuenow={width}
            tabIndex={onChatWidthChange ? 0 : -1} data-locked={onChatWidthChange ? undefined : true}
            onKeyDown={onChatWidthChange ? onKeyDown : undefined} onPointerDown={onChatWidthChange ? onPointerDown : undefined}
            onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
            <ResizeGrip id={hintId} title={resizeLabel} hint={resizeHint} side="start" />
          </div>
          <div inert={shown.leaving} className={styles.pane} data-slot="adaptive-shell-split-pane"><PaneLeavingContext.Provider value={shown.leaving}>{paneOpen ? pane : lastPane.current}</PaneLeavingContext.Provider></div>
        </>
      ) : null}
      <SplitPaneMotion ref={motion} split={split} open={paneOpen} contextKey={contextKey} leaving={shown.leaving}
        onExited={() => setShown((current) => ({ ...current, leaving: false }))} />
    </div>
  );
}

/**
 * The left-edge hover zone of a collapsed sidebar: entering it asks for a peek (AdaptiveShell `leftPeek`).
 * Render it only while the sidebar is closed; useSidebarPeek ends the peek.
 */
export function AdaptiveShellPeekEdge({ onPeek }: { onPeek: () => void }) {
  return <div className={styles.peekEdge} data-slot="adaptive-shell-peek-edge" aria-hidden="true" onPointerEnter={onPeek} />;
}
