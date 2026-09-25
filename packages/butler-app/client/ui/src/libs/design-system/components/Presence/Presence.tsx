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

function cssTimeMs(value: string | undefined): number {
  const first = (value ?? "").split(",")[0]?.trim() ?? "";
  const match = /^(-?\d*\.?\d+)(ms|s)$/u.exec(first);
  if (!match) return 0;
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

/**
 * Keeps an element mounted through its exit animation. While `present` is
 * false the element carries `data-state="closed"`; it unmounts when its CSS
 * exit animation ends (immediately when it has none).
 */
export function usePresence(present: boolean): {
  mounted: boolean;
  state: PresenceState;
  ref: (node: HTMLElement | null) => void;
} {
  const [mounted, setMounted] = useState(present);
  const nodeRef = useRef<HTMLElement | null>(null);
  if (present && !mounted) setMounted(true);

  useLayoutEffect(() => {
    if (present || !mounted) return undefined;
    const node = nodeRef.current;
    const style = node ? window.getComputedStyle(node) : null;
    const animationName = style?.animationName ?? "none";
    if (!node || !animationName || animationName === "none") {
      setMounted(false);
      return undefined;
    }
    const finish = (event?: Event) => {
      if (event && event.target !== node) return;
      setMounted(false);
    };
    const timer = window.setTimeout(
      finish,
      cssTimeMs(style?.animationDuration) + cssTimeMs(style?.animationDelay) + EXIT_GRACE_MS,
    );
    node.addEventListener("animationend", finish);
    node.addEventListener("animationcancel", finish);
    return () => {
      window.clearTimeout(timer);
      node.removeEventListener("animationend", finish);
      node.removeEventListener("animationcancel", finish);
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
