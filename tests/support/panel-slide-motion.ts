import type { Locator } from "playwright";

/**
 * Deterministic measurement of a docked panel's closing slide (#797).
 *
 * Sampling a wall-clock delay after the click races the compositor: under
 * load the 220ms slide has already finished, or barely started, by the time
 * the box is read. Instead, a MutationObserver armed on the panel catches the
 * `data-open="false"` commit; its callback runs in the same task as the
 * commit, before any frame, so it pauses the freshly created CSS transitions
 * at their start. The check then reads the running transform transition's
 * timing against the motion tokens and seeks it to fixed fractions of its
 * duration to read the in-between geometry.
 */

export type PanelBox = { x: number; y: number; width: number; height: number };

export type PanelSlideSample = {
  fraction: number;
  box: PanelBox;
  /** Box of `contentSelector` inside the panel at this point, when given. */
  content?: PanelBox & { opacity: string; transform: string };
};

export type PanelSlideCapture = {
  /** Transitions created on the panel by the close commit. */
  properties: string[];
  duration: number | null;
  delay: number | null;
  easing: string | null;
  tokenDuration: number;
  tokenEasing: string;
  viewportWidth: number;
  samples: PanelSlideSample[];
};

type CaptureState = { transitions: Animation[] } | undefined;
type CaptureWindow = { __butlerPanelSlideCapture?: CaptureState };

/** Arms the capture; call immediately before the click that closes the panel. */
export async function armPanelSlideCapture(panel: Locator): Promise<void> {
  await panel.evaluate((element) => {
    const host = window as unknown as CaptureWindow;
    host.__butlerPanelSlideCapture = undefined;
    const observer = new MutationObserver(() => {
      if (element.getAttribute("data-open") !== "false") return;
      observer.disconnect();
      // getAnimations() flushes style, which creates the close transitions.
      const transitions = element
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition);
      for (const transition of transitions) transition.pause();
      host.__butlerPanelSlideCapture = { transitions };
    });
    observer.observe(element, { attributes: true, attributeFilter: ["data-open"] });
  });
}

/**
 * Reads the paused close transitions, samples the panel at each fraction of
 * the transform transition's duration, then lets the transitions finish.
 */
export async function readPanelSlideCapture(
  panel: Locator,
  fractions: number[],
  contentSelector?: string,
): Promise<PanelSlideCapture> {
  await panel.page().waitForFunction(() =>
    (window as unknown as CaptureWindow).__butlerPanelSlideCapture !== undefined);
  return panel.evaluate(async (element, { fractions, contentSelector }) => {
    const host = window as unknown as CaptureWindow;
    const transitions = (host.__butlerPanelSlideCapture?.transitions ?? []) as CSSTransition[];
    host.__butlerPanelSlideCapture = undefined;
    const style = getComputedStyle(element);
    const toMs = (value: string) => {
      const text = value.trim();
      const number = Number.parseFloat(text);
      return text.endsWith("ms") ? number : text.endsWith("s") ? number * 1000 : Number.NaN;
    };
    // Serialize the token the way the engine reports a timing's easing.
    const canonicalEasing = (value: string) => {
      const probe = document.createElement("div").style;
      probe.transitionTimingFunction = value.trim();
      return probe.transitionTimingFunction;
    };
    const rect = (node: Element): PanelBox => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const slide = transitions.find((transition) => transition.transitionProperty === "transform");
    const timing = slide?.effect?.getComputedTiming();
    const samples: PanelSlideSample[] = [];
    if (slide && typeof timing?.duration === "number") {
      for (const fraction of fractions) {
        slide.currentTime = timing.duration * fraction;
        const content = contentSelector ? element.querySelector(contentSelector) : null;
        samples.push({
          fraction,
          box: rect(element),
          content: content
            ? { ...rect(content), opacity: getComputedStyle(content).opacity, transform: getComputedStyle(content).transform }
            : undefined,
        });
      }
    }
    const capture = {
      properties: transitions.map((transition) => transition.transitionProperty),
      duration: typeof timing?.duration === "number" ? timing.duration : null,
      delay: timing?.delay ?? null,
      easing: timing?.easing ?? null,
      tokenDuration: toMs(style.getPropertyValue("--adaptive-panel-duration")),
      tokenEasing: canonicalEasing(style.getPropertyValue("--adaptive-panel-easing")),
      viewportWidth: window.innerWidth,
      samples,
    };
    for (const transition of transitions) transition.play();
    await Promise.all(transitions.map((transition) => transition.finished.catch(() => undefined)));
    return capture;
  }, { fractions, contentSelector });
}
