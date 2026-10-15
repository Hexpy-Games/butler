import type { DsBaseProps } from "../../lib/dsProps";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { animateMotion, easeProgress, motionDuration, prefersReducedMotion } from "../../lib/motion";
import { cn } from "../../lib/utils";
import styles from "./AnimatedNumber.module.css";

export interface AnimatedNumberProps extends Omit<DsBaseProps<HTMLAttributes<HTMLSpanElement>>, "children"> {
  value: number;
  /** Formats every shown value; defaults to Intl.NumberFormat in the document language. */
  format?: (value: number) => string;
  /** Announce value changes politely (the final value only). */
  live?: boolean;
}

function defaultFormat(value: number): string {
  const lang = typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
  return new Intl.NumberFormat(lang).format(value);
}

/**
 * A number that counts to its new value over --motion-deliberate with the
 * decelerate easing (reduced motion: instant swap with a fade). Tabular
 * numerals and start/end sizers in one grid cell keep the width stable while
 * counting; the start sizer is released when the count ends. Assistive tech
 * reads the final value from static text.
 */
export function AnimatedNumber({ value, format = defaultFormat, live = false, className, ...props }: AnimatedNumberProps) {
  const [display, setDisplay] = useState(value);
  const [from, setFrom] = useState(value);
  const displayRef = useRef(value);
  const valueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const start = displayRef.current;
    const show = (next: number) => { displayRef.current = next; setDisplay(next); };
    // The start sizer holds the width only while counting; every settled
    // state releases it so a shorter value takes its own width.
    if (start === value) {
      setFrom(value);
      return undefined;
    }
    if (prefersReducedMotion()) {
      setFrom(value);
      show(value);
      if (valueRef.current) animateMotion(valueRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: "fast" });
      return undefined;
    }
    setFrom(start);
    const duration = motionDuration("deliberate");
    const integers = Number.isInteger(start) && Number.isInteger(value);
    let origin: number | null = null;
    let frame = 0;
    let cancelled = false;
    const tick = (timestamp: number) => {
      if (cancelled) return;
      origin ??= timestamp;
      const t = duration > 0 ? (timestamp - origin) / duration : 1;
      const next = t >= 1 ? value : start + (value - start) * easeProgress("decelerate", t);
      show(integers ? Math.round(next) : next);
      if (t < 1) frame = requestAnimationFrame(tick);
      else setFrom(value);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [value]);

  const finalText = format(value);
  return (
    <span className={cn(styles.root, className)} data-slot="animated-number" data-numeric="tabular" {...props}>
      <span className={styles.final} data-slot="animated-number-final" aria-live={live ? "polite" : undefined}>{finalText}</span>
      <span className={styles.stack} aria-hidden="true">
        <span className={styles.sizer} data-slot="animated-number-sizer">{format(from)}</span>
        <span className={styles.sizer} data-slot="animated-number-sizer">{finalText}</span>
        <span className={styles.value} data-slot="animated-number-value" ref={valueRef}>{format(display)}</span>
      </span>
    </span>
  );
}

export default AnimatedNumber;
