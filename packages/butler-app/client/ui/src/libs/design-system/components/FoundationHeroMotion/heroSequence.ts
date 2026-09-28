import { useEffect, useState, type CSSProperties, type RefObject } from "react";

/** Slot counts with a generated fade/move keyframe pair in the stylesheet. */
export type SlotCount = 4 | 5 | 6 | 10 | 16;

/** 0,1,…,n-1,n-2,…,1: a ramp walked up and back down, as slot indices. */
export function pingPong(n: number): number[] {
  return [...Array.from({ length: n }, (_, index) => index), ...Array.from({ length: Math.max(0, n - 2) }, (_, index) => n - 2 - index)];
}

export interface SlotMotion {
  /** Transform the element enters from (usually the previous element's geometry). */
  from?: string;
  /** Transform it rests at while it is the current slot. */
  rest?: string;
  /** Transform it leaves to (the next element's geometry). */
  to?: string;
}

/**
 * Inline custom properties of the k-th of `slots` elements that take turns
 * (one keyframe pair per slot count, offset by animation-delay). Every element
 * shares the cycle, so pausing the stage keeps them in step.
 */
export function slotStyle(slots: SlotCount, k: number, motion: SlotMotion = {}, extra: Record<string, string | number> = {}): CSSProperties {
  return {
    "--hero-slots": slots,
    "--k": k,
    "--from": motion.from ?? motion.rest ?? "none",
    "--rest": motion.rest ?? "none",
    "--to": motion.to ?? motion.rest ?? "none",
    ...extra,
  } as CSSProperties;
}

/** FLIP scales of a ping-pong walk over sizes: element j enters at the previous size and leaves at the next. */
export function flipScales(sizes: number[], order: number[]): Array<{ size: number; from: string; to: string }> {
  return order.map((index, position) => {
    const size = sizes[index]!;
    const previous = sizes[order[(position - 1 + order.length) % order.length]!]!;
    const next = sizes[order[(position + 1) % order.length]!]!;
    return { size, from: `scale(${round(previous / size)})`, to: `scale(${round(next / size)})` };
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Pixel values of length tokens as computed on the hero (theme, density and
 * platform overrides included); the fallback holds until the first effect.
 */
export function useTokenPx<Name extends string>(ref: RefObject<Element | null>, fallback: Record<Name, number>): Record<Name, number> {
  const [values, setValues] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof getComputedStyle !== "function") return;
    const style = getComputedStyle(element);
    const next = { ...fallback };
    for (const name of Object.keys(fallback) as Name[]) {
      const parsed = Number.parseFloat(style.getPropertyValue(name));
      if (Number.isFinite(parsed) && parsed > 0) next[name] = parsed;
    }
    setValues((current) => (Object.keys(next).every((name) => next[name as Name] === current[name as Name]) ? current : next));
    // Token names are static per variant: read once per mount.
  }, [ref]);
  return values;
}
