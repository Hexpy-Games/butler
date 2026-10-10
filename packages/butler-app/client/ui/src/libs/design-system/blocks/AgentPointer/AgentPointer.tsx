import { useEffect, useId, useState, type CSSProperties } from "react";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { prefersReducedMotion, subscribeReducedMotion } from "../../lib/motion";
import { cn } from "../../lib/utils";
import styles from "./AgentPointer.module.css";
import { coversLayer, glideCurve, pathData, samePoint, throughCurve } from "./pointerPath";
import { usePointerGlide } from "./usePointerGlide";
import { useTargetRings } from "./useTargetRings";

/**
 * `observe` rings what Butler reads; `click` ripples at the point; `type` puts a caret in the field and the
 * value below it; `scroll` parks at the right edge beside a scroll rail; `batch` numbers the stops of one
 * action; `parked` (you hold the tab, or an approval waits) fades the pointer and nothing moves.
 */
export type AgentPointerMode = "observe" | "click" | "type" | "scroll" | "batch" | "parked";
export type AgentPointerTone = "default" | "waiting" | "need-input";

export interface AgentPointerPoint { x: number; y: number }
export interface AgentPointerRect { x: number; y: number; width: number; height: number }

export interface AgentPointerLabels {
  butler: string;
  looking: string;
  typing: string;
  waiting: string;
  awaitingApproval: string;
  needInput: string;
}

const DEFAULT_LABELS: AgentPointerLabels = {
  butler: "Butler", looking: "Looking", typing: "Typing", waiting: "Waiting",
  awaitingApproval: "Awaiting approval", needInput: "Waiting for your input",
};

export interface AgentPointerProps extends DsPrivateStyleProps {
  mode: AgentPointerMode;
  tone?: AgentPointerTone;
  /** The pointer tip, in layer pixels (the page's CSS pixels times the page scale). A new value glides there. */
  at: AgentPointerPoint;
  /**
   * The element Butler acts on, in layer pixels. Its ring appears in place (it never morphs from the last
   * target); a whole-page target (edge to edge) draws no ring, since the PageCard edge already outlines it.
   */
  target?: AgentPointerRect;
  /** Where the pointer came from: a dotted trail to `at` along the glide's curve (dropped under reduced motion). */
  from?: AgentPointerPoint;
  /** `batch`: the stops in order; the last one is current. */
  steps?: AgentPointerPoint[];
  /** `type`: what Butler is typing (masked by the App for secrets). */
  value?: string;
  /** Layer size: the trail canvas and the scroll rail. */
  width: number;
  height: number;
  labels?: Partial<AgentPointerLabels>;
  /** Forces reduced motion (no glide, trail, ripple or ring fade); otherwise the OS setting and the DS scope apply. */
  reducedMotion?: boolean;
}

function tagText(mode: AgentPointerMode, tone: AgentPointerTone, labels: AgentPointerLabels) {
  if (mode !== "parked") return labels.butler;
  return tone === "waiting" ? labels.awaitingApproval : tone === "need-input" ? labels.needInput : labels.waiting;
}

const box = (rect: AgentPointerRect): CSSProperties => ({
  width: rect.width + 6, height: rect.height + 6, translate: `${rect.x - 3}px ${rect.y - 3}px`,
});
const place = (point: AgentPointerPoint): CSSProperties => ({ translate: `${point.x}px ${point.y}px` });

/**
 * Butler's own pointer for the transparent overlay layer above a page (never the page DOM): a riso arrow
 * with a "Butler" tag, a dark halo and a white keyline so it reads on white, black and photo pages. Pure
 * presenter with no App store; the overlay renderer passes geometry in layer pixels. It always uses the
 * light inks: it is drawn over web pages, not over Butler's own (possibly dark) chrome.
 *
 * Motion: the arrow glides to each new `at` along a gentle curve (transform keyframes, interruptible);
 * rings never animate geometry, they fade in and out where their targets are.
 */
export function AgentPointer({
  mode, tone = "default", at, target, from, steps = [], value, width, height, labels: labelOverrides, reducedMotion, className,
}: AgentPointerProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const paint = `agent-pointer-${useId().replace(/[^\w-]/gu, "")}`;
  const [systemReduced, setSystemReduced] = useState(prefersReducedMotion);
  useEffect(() => subscribeReducedMotion(setSystemReduced), []);
  const reduced = reducedMotion === true || systemReduced;
  const glide = usePointerGlide(at, steps, mode === "batch", reduced);
  const rings = useTargetRings(target && mode !== "scroll" && !coversLayer(target, width, height) ? target : undefined, reduced);
  // The trail is the glide's own curve (from the drawn position after a retarget), else the curve from `from`.
  const trail = mode === "batch" ? throughCurve(steps) : from && !samePoint(from, at) ? [glide.path ?? glideCurve(from, at)] : [];
  // Near the layer's right edge the tag sits left of the tip, so it is never clipped.
  const flip = at.x > width - 120;
  return (
    <div className={cn("theme-light", styles.layer, className)} data-slot="agent-pointer" data-mode={mode} data-tone={tone}
      data-reduced={reduced ? "true" : undefined} aria-hidden="true">
      {trail.length ? (
        <svg className={styles.trail} width={width} height={height}><path d={pathData(trail)} /></svg>
      ) : null}
      {mode === "batch" ? steps.map((point, index) => (
        <span key={`${point.x},${point.y},${index}`} className={styles.stop} style={place(point)} data-done={index < steps.length - 1 || undefined}>
          {index + 1}
        </span>
      )) : null}
      {[...rings.leaving, ...(rings.current ? [rings.current] : [])].map((ring) => {
        const current = ring === rings.current;
        return (
          <div key={ring.key} className={styles.ring} style={box(ring.rect)} data-part="ring" data-leaving={current ? undefined : ""}
            onAnimationEnd={current ? undefined : (event) => { if (event.target === event.currentTarget) rings.drop(ring.key); }}>
            {current && mode === "observe" ? <span className={styles.ringTag}>{labels.looking}</span> : null}
            {current && mode === "type" ? <span className={styles.caret} /> : null}
            {current && mode === "type" && value ? <span className={styles.valueChip}>{`${labels.typing} · ${value}`}</span> : null}
          </div>
        );
      })}
      {/* The click lands when the pointer arrives: a new ripple per arrival, none while gliding. */}
      {mode === "click" && glide.arrived ? (
        <span key={`${glide.arrived.x},${glide.arrived.y}`} className={styles.ripple} style={place(glide.arrived)} data-part="ripple" />
      ) : null}
      {mode === "scroll" ? <div className={styles.rail} style={{ height: height * 0.64, translate: `0 ${height * 0.18}px` }}><span className={styles.thumb} /></div> : null}
      <div ref={glide.ref}className={styles.pointer} style={place(at)} data-part="pointer" data-flip={flip || undefined}>
        <svg width="22" height="26" viewBox="0 0 22 26" focusable="false">
          <defs>
            <linearGradient id={paint} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--butler-ink-blue)" />
              <stop offset="0.55" stopColor="var(--butler-ink-purple)" />
              <stop offset="1" stopColor="var(--butler-ink-pink)" />
            </linearGradient>
          </defs>
          <path className={styles.halo} d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15 L18 15 Z" />
          <path className={styles.arrow} d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15 L18 15 Z" fill={`url(#${paint})`} />
        </svg>
        {mode === "type" && value ? null : <span className={styles.tag}>{tagText(mode, tone, labels)}</span>}
      </div>
    </div>
  );
}
