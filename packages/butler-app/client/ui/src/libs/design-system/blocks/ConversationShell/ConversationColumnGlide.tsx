import { Component } from "react";
import { animateMotion } from "../../lib/motion";

/** Elements that move with the conversation column (the message list, the floating composer, the scroll button). */
const COLUMN_SELECTOR = "[data-column-glide]";
/** The docked aside (AsideSlot): it travels with the column, so the two never overlap. */
const DOCKED_ASIDE_SELECTOR = '[data-slot="conversation-aside"][data-layout="docked"]';

interface ConversationColumnGlideProps {
  shell: HTMLElement | null;
  /** The aside docks in the margin: the column moves left. */
  docked: boolean;
  /** The column makes room for a TabRail. */
  railed: boolean;
}

type Snapshot = Map<Element, number> | null;

const running = new WeakMap<Element, Animation>();

function columnLefts(shell: HTMLElement): Map<Element, number> {
  const lefts = new Map<Element, number>();
  for (const element of shell.querySelectorAll(COLUMN_SELECTOR)) lefts.set(element, element.getBoundingClientRect().left);
  return lefts;
}

/**
 * A transform glide on the motion tokens, added to the element's own transform (the composer's centring
 * stays live while the window resizes), kept so a new glide can start from where this one is.
 */
function glide(element: Element, from: number, to: number, fill?: FillMode) {
  const animation = animateMotion(element, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
    { duration: "slow", easing: "emphasized", composite: "add", ...(fill ? { fill } : {}) });
  if (animation) running.set(element, animation);
}

/**
 * The column glides to its new place (FLIP) when the aside docks or leaves, or the rail's room comes or
 * goes. The shell's CSS moves the column at once; each marked element starts where it was on screen
 * (mid-glide included) and travels back on a transform, so nothing reflows while it moves and the
 * transcript keeps its scroll position. A width change applies at once (text wraps once, before the
 * glide). The docked aside rides along: it enters from the right as the column makes room and leaves
 * to the right as the column comes back, so the pane pushes the column rather than covering it.
 * Reduced motion places everything at once.
 */
export class ConversationColumnGlide extends Component<ConversationColumnGlideProps> {
  getSnapshotBeforeUpdate(previous: ConversationColumnGlideProps): Snapshot {
    const { shell, docked, railed } = this.props;
    if (!shell || shell !== previous.shell || (docked === previous.docked && railed === previous.railed)) return null;
    return columnLefts(shell);
  }

  componentDidUpdate(previous: ConversationColumnGlideProps, _state: unknown, snapshot: Snapshot) {
    const shell = this.props.shell;
    if (!snapshot || !shell) return;
    for (const element of snapshot.keys()) running.get(element)?.cancel();
    // Rects are on screen; the transform is in the shell's own px (a scaled ancestor, e.g. a DS story frame).
    const scale = shell.getBoundingClientRect().width / shell.offsetWidth || 1;
    let travel = 0;
    for (const [element, left] of columnLefts(shell)) {
      const before = snapshot.get(element);
      const dx = before === undefined ? 0 : (before - left) / scale;
      if (Math.abs(dx) < 1) continue;
      glide(element, dx, 0);
      if (Math.abs(dx) > Math.abs(travel)) travel = dx;
    }
    const aside = shell.querySelector(DOCKED_ASIDE_SELECTOR);
    if (!aside || this.props.docked === previous.docked) return;
    running.get(aside)?.cancel();
    if (this.props.docked && travel > 0) glide(aside, travel, 0);
    else if (!this.props.docked && travel < 0) glide(aside, 0, -travel, "forwards");
  }

  render() {
    return null;
  }
}
