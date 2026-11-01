import { Component } from "react";
import { animateMotion, motionDuration, prefersReducedMotion, type MotionOptions } from "../../lib/motion";
import { NATIVE_VIEW_HOLD } from "../NativeViewSlot/nativeViewGeometry";

const MOTION: MotionOptions = { duration: "slow", easing: "emphasized" };
const CHAT_WIDTH = "var(--browser-chat-width)";
/** Parked just past the split's end: as far from its place as the chat's edge is when the chat fills the split. */
const OFF_EDGE = `calc(100% - ${CHAT_WIDTH})`;

interface SplitPaneMotionProps {
  split: HTMLElement | null;
  /** The pane is open (false while it leaves). */
  open: boolean;
  /** What the split shows: when it changes (another conversation) the new state is placed at once. */
  contextKey?: string;
  /** The pane is still mounted while it leaves. */
  leaving: boolean;
  /** The pane's leaving motion ended: it can unmount now. */
  onExited: () => void;
}

type Geometry = { chat: string; title: string | null; pane: string | null };

function parts(split: HTMLElement) {
  return {
    chat: split.querySelector<HTMLElement>(':scope > [data-slot="adaptive-shell-split-chat"]'),
    pane: split.querySelector<HTMLElement>(':scope > [data-slot="adaptive-shell-split-pane"]'),
    title: split.closest('[data-slot="adaptive-shell-workspace"]')?.querySelector<HTMLElement>('[data-slot="titlebar-chat-group"]') ?? null,
  };
}

/** Computed values, so a running motion reads at its current frame and a new one starts from there. */
function readGeometry(split: HTMLElement): Geometry | null {
  const { chat, pane, title } = parts(split);
  if (!chat) return null;
  return {
    chat: getComputedStyle(chat).width,
    title: title ? getComputedStyle(title).width : null,
    pane: pane ? `${parseFloat(getComputedStyle(pane).left) || 0}px` : null,
  };
}

const chatFrame = (width: string): Keyframe => ({ width, marginInlineEnd: `calc(${CHAT_WIDTH} - ${width})` });

function titleFrame(width: string): Keyframe {
  return { flexBasis: width, flexGrow: 0, flexShrink: 0 };
}

/**
 * A native view on screen in the pane cannot follow a transform: it trails it by frames, and at the motion's speed
 * it would show far off its pane. So the slot is told to cover it first, and `start` runs once the still stands in
 * (one capture and a paint, tens of ms), or after one motion's length at the most. Returns the cancel.
 */
function afterStandIn(pane: HTMLElement | null, start: () => void): () => void {
  const slot = pane?.querySelector<HTMLElement>('[data-slot="native-view-slot"]:not([data-hidden])');
  if (!pane || !slot || slot.hasAttribute("data-stand-in")) { start(); return () => undefined; }
  pane.setAttribute(NATIVE_VIEW_HOLD, "");
  const finish = () => { cancel(); start(); };
  const observer = new MutationObserver(() => { if (slot.hasAttribute("data-stand-in")) finish(); });
  const timer = setTimeout(finish, motionDuration("slow"));
  const cancel = () => { observer.disconnect(); clearTimeout(timer); pane.removeAttribute(NATIVE_VIEW_HOLD); };
  observer.observe(slot, { attributes: true, attributeFilter: ["data-stand-in"] });
  return cancel;
}

/**
 * The right pane opening or closing beside the chat. Every pane in the split takes this one path. The flow keeps
 * the open layout while it moves, so the pane holds its final size and only travels (its content never reflows). The
 * chat card's edge follows it: its width animates over a negative margin that keeps the flow still. The title row's
 * chat group ends with the card. All of them run on the main thread, started at one timeline time, so every painted
 * frame has them together. (A transform would run on the compositor, ahead of a busy main thread and the chat's width.)
 * A pane holding a native view waits for its still (afterStandIn); the whole motion waits, in either direction.
 * A new toggle starts from the frame on screen (mid-motion included). A first mount, another conversation and
 * reduced motion place everything at once; reduced motion fades an opening pane in.
 */
export class SplitPaneMotion extends Component<SplitPaneMotionProps> {
  private motion: Animation[] = [];
  private cancelHold: () => void = () => undefined;

  /** A resize takes the chat width over: nothing may lag behind the pointer or the keys. */
  settle() {
    if (!this.props.open) return;
    this.cancelHold();
    for (const animation of this.motion) animation.finish();
    this.motion = [];
  }

  getSnapshotBeforeUpdate(previous: SplitPaneMotionProps): Geometry | null {
    const { split, open, contextKey } = this.props;
    if (!split || previous.open === open || previous.contextKey !== contextKey || prefersReducedMotion()) return null;
    return readGeometry(split);
  }

  componentDidUpdate(previous: SplitPaneMotionProps, _state: unknown, from: Geometry | null) {
    const { split, open, contextKey, leaving, onExited } = this.props;
    // Same commit as the unmount: the held last frame gives way to the layout it matches.
    if (previous.leaving && !leaving) this.cancel();
    if (previous.open === open) return;
    this.cancel();
    if (!split || !from) {
      if (leaving) onExited();
      const pane = split && parts(split).pane;
      if (open && pane && previous.contextKey === contextKey && prefersReducedMotion()) animateMotion(pane, [{ opacity: 0 }, { opacity: 1 }], MOTION);
      return;
    }
    if (open) { this.enter(split, from); return; }
    const leaveMotion = this.leave(split, from);
    if (!leaveMotion) { onExited(); return; }
    leaveMotion.finished.then(() => { if (this.motion.includes(leaveMotion)) onExited(); }, () => undefined);
  }

  componentWillUnmount() {
    this.cancel();
  }

  private cancel() {
    this.cancelHold();
    for (const animation of this.motion) animation.cancel();
    this.motion = [];
  }

  /** Keeps `animations` on their first frame until the pane's native view (if any) is covered. */
  private holdUntilStandIn(pane: HTMLElement | null, animations: Array<Animation | null | undefined>) {
    const held = animations.filter((animation): animation is Animation => Boolean(animation));
    for (const animation of held) animation.pause();
    this.motion.push(...held);
    this.cancelHold = afterStandIn(pane, () => {
      const now = held[0]?.timeline?.currentTime ?? null;
      for (const animation of held) animation.startTime = now;
    });
  }

  private enter(split: HTMLElement, from: Geometry) {
    const { chat, pane, title } = parts(split);
    this.holdUntilStandIn(pane, [
      chat && animateMotion(chat, [chatFrame(from.chat), chatFrame(CHAT_WIDTH)], MOTION),
      title && from.title ? animateMotion(title, [titleFrame(from.title), titleFrame(getComputedStyle(title).width)], MOTION) : null,
      pane && animateMotion(pane, [{ left: from.pane ?? OFF_EDGE }, { left: "0px" }], MOTION),
    ]);
  }

  /** Held at the last frame until the pane unmounts, so nothing shows the open layout again. Returns the last to end. */
  private leave(split: HTMLElement, from: Geometry) {
    const { chat, pane, title } = parts(split);
    const hold: MotionOptions = { ...MOTION, fill: "forwards" };
    const chatMotion = chat && animateMotion(chat, [chatFrame(from.chat), chatFrame("100%")], hold);
    const paneMotion = pane && animateMotion(pane, [{ left: from.pane ?? "0px" }, { left: OFF_EDGE }], hold);
    this.holdUntilStandIn(pane, [
      title && from.title ? animateMotion(title, [titleFrame(from.title), titleFrame(getComputedStyle(title).width)], MOTION) : null,
      chatMotion,
      paneMotion,
    ]);
    return paneMotion ?? chatMotion ?? null;
  }

  render() {
    return null;
  }
}
