import {
  useLayoutEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ReactNode,
} from "react";
import styles from "./RollingSwap.module.css";

type RollingFrame = {
  key: string;
  content: ReactNode;
};

export interface RollingSwapProps {
  children: ReactNode;
  itemKey: string;
  motion?: boolean;
}

export function RollingSwap({
  children,
  itemKey,
  motion = true,
}: RollingSwapProps) {
  const previous = useRef<RollingFrame>({ key: itemKey, content: children });
  const [outgoing, setOutgoing] = useState<RollingFrame | null>(null);

  useLayoutEffect(() => {
    const prior = previous.current;
    previous.current = { key: itemKey, content: children };
    if (prior.key === itemKey) return;
    if (!motion || prefersReducedMotion()) {
      setOutgoing(null);
      return;
    }
    setOutgoing(prior);
  }, [children, itemKey, motion]);

  const finishTransition = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setOutgoing(null);
  };

  return (
    <div className={styles.viewport} data-slot="rolling-swap">
      {outgoing ? (
        <div
          aria-hidden="true"
          className={`${styles.frame} ${styles.outgoing}`}
          data-motion="outgoing"
        >
          {outgoing.content}
        </div>
      ) : null}
      <div
        className={`${styles.frame} ${outgoing ? styles.incoming : ""}`}
        data-motion={outgoing ? "incoming" : "current"}
        key={itemKey}
        onAnimationEnd={finishTransition}
      >
        {children}
      </div>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
