// The card side of the first-run ink intro (intro spec rev 5 motion table, DOM rows): the card surface and the DOM
// mark arrive as the GL mark lands, the text follows 70 ms apart; without WebGL2 the SVG mark draws itself first.
import { animateMotion, motionDistance, motionDuration } from "../../lib/motion";
import { RISO_INTRO_TIMELINE_S as T, type WallpaperIntroStart } from "../Wallpaper/intro/introTimeline";
import { boxIn, placeSurface } from "./setupMorphLayers";

const CARD = "[data-setup-card]";
const MARK = "[data-setup-mark]";
const ROW_GROUP = "data-setup-rows";

const present = (animation: Animation | null): animation is Animation => animation !== null;
const ms = (seconds: number) => Math.round(seconds * 1000);

/** The text lines in reading order: the row holding the mark gives its other children, a row group its children. */
function introRows(card: Element, mark: Element | null): Element[] {
  const column = card.firstElementChild;
  if (!column) return [];
  return [...column.children].flatMap((row) => {
    if (mark && row.contains(mark)) return [...row.children].filter((child) => !child.contains(mark));
    return row.hasAttribute(ROW_GROUP) ? [...row.children] : [row];
  });
}

/** The card surface fades in from 97% around the mark (the mark never moves), then the lines rise in 70 ms apart. */
function cardIn(stage: HTMLElement, surface: HTMLElement, card: HTMLElement, mark: Element | null, at: { card: number; text: number }): Animation[] {
  const origin = stage.getBoundingClientRect();
  const box = boxIn(card, origin);
  const pin = mark?.getBoundingClientRect();
  placeSurface(surface, box, pin ? { x: pin.left + pin.width / 2 - origin.left - box.left, y: pin.top + pin.height / 2 - origin.top - box.top } : { x: box.width / 2, y: 0 });
  const rise = "translateY(" + motionDistance("md") + "px)";
  const step = motionDuration("stagger-intro");
  return [
    animateMotion(surface, [{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }],
      { duration: "deliberate", easing: "decelerate", delay: ms(at.card), fill: "backwards" }),
    ...introRows(card, mark).map((row, index) => animateMotion(row, [{ opacity: 0, transform: rise }, { opacity: 1, transform: "none" }],
      { duration: "deliberate", easing: "decelerate", delay: ms(at.text) + index * step, fill: "backwards" })),
  ].filter(present);
}

/**
 * The card motion for how the intro started. full: the DOM mark takes over from the GL mark at the glide end.
 * fallback: the SVG ring draws clockwise from the top and the bow tie prints, then the card. still (reduced motion,
 * software GL): the card fades in as a whole. Returns the running animations (none: nothing to wait for).
 */
export function playSetupIntro(stage: HTMLElement, surface: HTMLElement, frame: HTMLElement, kind: WallpaperIntroStart): Animation[] {
  const card = frame.querySelector<HTMLElement>(CARD);
  if (kind === "still" || !card) {
    return [animateMotion(frame, [{ opacity: 0 }, { opacity: 1 }], { duration: "base", easing: "standard", fill: "backwards" })].filter(present);
  }
  const mark = card.querySelector(MARK);
  if (kind === "full") {
    const handOff = mark && animateMotion(mark, [{ opacity: 0 }, { opacity: 1 }], { duration: "fast", easing: "standard", delay: ms(T.dom.mark), fill: "backwards" });
    return [...cardIn(stage, surface, card, mark, T.dom), handOff ?? null].filter(present);
  }
  const ring = mark?.querySelector("[data-mark-ring]");
  const bow = mark?.querySelector("[data-mark-bow]");
  return [
    ring ? animateMotion(ring, [{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], { duration: "intro-draw", easing: "draw", delay: ms(T.fallback.ring), fill: "backwards" }) : null,
    bow ? animateMotion(bow, [{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "none" }], { duration: "intro-print", easing: "standard", delay: ms(T.fallback.bow), fill: "backwards" }) : null,
    ...cardIn(stage, surface, card, mark, T.fallback),
  ].filter(present);
}
