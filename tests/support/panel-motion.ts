import type { Page } from "playwright";

/** Seek the actual transition; renderer IPC latency must not pick the sample. */
export async function pausePanelClose(page: Page, buttonName: string, selector: string): Promise<number> {
  return page.getByRole("button", { name: buttonName }).evaluate(async (button, target) => {
    (button as HTMLElement).click();
    await new Promise((done) => requestAnimationFrame(done));
    const motion = document.querySelector(target)?.getAnimations().find((animation) =>
      (animation.effect as KeyframeEffect).getKeyframes().some((frame) => "transform" in frame));
    if (!motion) return 0;
    const duration = Number(motion.effect?.getTiming().duration);
    motion.pause();
    motion.currentTime = duration / 2;
    (document as Document & { smokePanelMotion?: Animation }).smokePanelMotion = motion;
    return duration;
  }, selector);
}

export async function resumePanelClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = document as Document & { smokePanelMotion?: Animation };
    state.smokePanelMotion?.play();
    delete state.smokePanelMotion;
  });
}
