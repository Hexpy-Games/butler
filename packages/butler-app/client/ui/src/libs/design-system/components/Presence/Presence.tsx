import {
  cloneElement,
  isValidElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { useComposedRefs } from "../../lib/composeRefs";
import { cn } from "../../lib/utils";
import styles from "./Presence.module.css";

export type PresenceState = "open" | "closed";

/** Extra wait after the computed exit animation before unmounting anyway. */
const EXIT_GRACE_MS = 50;

/** Longest time in a computed CSS time list such as "0.16s, 0.11s". */
function cssTimeMs(value: string | undefined): number {
  return Math.max(0, ...(value ?? "").split(",").map((part) => {
    const match = /^(-?\d*\.?\d+)(ms|s)$/u.exec(part.trim());
    return match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : 0;
  }));
}

/**
 * Keeps an element mounted through its exit animation. While `present` is
 * false the element carries `data-state="closed"`; it unmounts when its CSS
 * exit animation (or, without one, its exit transition) ends, immediately
 * when it has neither.
 */
export function usePresence(present: boolean, options: { onExitComplete?: () => void } = {}): {
  mounted: boolean;
  state: PresenceState;
  ref: (node: HTMLElement | null) => void;
} {
  const [mounted, setMounted] = useState(present);
  const nodeRef = useRef<HTMLElement | null>(null);
  const onExitComplete = useRef(options.onExitComplete);
  onExitComplete.current = options.onExitComplete;
  if (present && !mounted) setMounted(true);

  useLayoutEffect(() => {
    if (present || !mounted) return undefined;
    const node = nodeRef.current;
    const style = node ? window.getComputedStyle(node) : null;
    const animationName = style?.animationName ?? "none";
    const animated = Boolean(animationName) && animationName !== "none";
    const transitionMs = cssTimeMs(style?.transitionDuration) + cssTimeMs(style?.transitionDelay);
    if (!node || (!animated && transitionMs <= 0)) {
      setMounted(false);
      onExitComplete.current?.();
      return undefined;
    }
    const endEvents = animated ? ["animationend", "animationcancel"] : ["transitionend", "transitioncancel"];
    let done = false;
    const finish = (event?: Event) => {
      if (event && event.target !== node) return;
      if (done) return;
      done = true;
      setMounted(false);
      onExitComplete.current?.();
    };
    const waitMs = animated
      ? cssTimeMs(style?.animationDuration) + cssTimeMs(style?.animationDelay)
      : transitionMs;
    const timer = window.setTimeout(finish, waitMs + EXIT_GRACE_MS);
    for (const type of endEvents) node.addEventListener(type, finish);
    return () => {
      window.clearTimeout(timer);
      for (const type of endEvents) node.removeEventListener(type, finish);
    };
  }, [present, mounted]);

  const ref = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
  }, []);

  return { mounted, state: present ? "open" : "closed", ref };
}

/** Built-in enter/exit: `fade`, `rise` (fade + --motion-distance-sm), or `none` when the child styles its own [data-state] keyframes. */
export type PresenceMotion = "none" | "fade" | "rise";

export interface PresenceProps {
  present: boolean;
  motion?: PresenceMotion;
  /** One element that styles `[data-state="open|closed"]` enter/exit keyframes. */
  children: ReactElement<{ "data-state"?: PresenceState; className?: string; ref?: Ref<HTMLElement> }>;
}

export function Presence({ present, motion = "none", children }: PresenceProps) {
  const { mounted, state, ref } = usePresence(present);
  const childRef = isValidElement(children)
    ? (children.props as { ref?: Ref<HTMLElement> }).ref
    : undefined;
  const composedRef = useComposedRefs<HTMLElement>(childRef, ref);
  if (!mounted || !isValidElement(children)) return null;
  return cloneElement(children, {
    "data-state": state,
    ref: composedRef,
    ...(motion === "none"
      ? {}
      : { className: cn(children.props.className, styles.presence, motion === "rise" ? styles.rise : styles.fade) }),
  });
}
