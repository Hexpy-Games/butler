import { useEffect, useState } from "react";
import type { AppLocale } from "../../../../../../../../butler-i18n/src/copy-contract.ts";
import { getAppCopy } from "../../../../../../../../butler-i18n/src/locale.ts";
import type { LiveTabCardProps, LiveTabState } from "./LiveTabCard";
import type { LiveTabFrameSource } from "./LiveTabFrame";
import { demoTabs, LIVE_PAGES } from "./fixtures";

/** Story states: attention comes as an approval (tag only) and a hand-off (the needs-you band). */
export type DemoState = Exclude<LiveTabState, "attention"> | "approval" | "handoff";
export const DEMO_STATES: readonly DemoState[] = ["busy", "handoff", "approval", "held", "error", "idle"];

const PAGE: Record<DemoState, string> = {
  busy: LIVE_PAGES.booking, handoff: LIVE_PAGES.sitesSignIn, approval: LIVE_PAGES.bookingApproval,
  held: LIVE_PAGES.sites, error: LIVE_PAGES.facilities, idle: LIVE_PAGES.reviews,
};
const TAB: Record<DemoState, number> = { busy: 0, handoff: 1, approval: 0, held: 1, error: 2, idle: 3 };

/** Card props as the App's AgentTabRail builds them: copy from butler-i18n browser.*, no-op commands. */
export function demoCard(locale: AppLocale, state: DemoState, overrides: Partial<LiveTabCardProps> = {}): LiveTabCardProps {
  const copy = getAppCopy(locale).browser;
  const tab = demoTabs(locale)[TAB[state]]!;
  const noop = () => undefined;
  const stateLabel = { busy: copy.agentUsing, handoff: copy.rail.needsCheck, approval: copy.waiting, held: copy.userControl, error: copy.rail.error, idle: undefined }[state];
  return {
    title: tab.title, shortTitle: tab.site, favicon: tab.favicon, frame: PAGE[state],
    state: state === "approval" || state === "handoff" ? "attention" : state, stateLabel,
    needsYou: state === "handoff" ? { detail: copy.mfa, action: { label: copy.rail.openToCheck, onAction: noop } } : undefined,
    failure: state === "error" ? { label: copy.rail.pageError, action: { label: copy.reload, onAction: noop } } : undefined,
    onOpen: noop, onClose: noop, closeLabel: copy.closeTab, ...overrides,
  };
}

/** Decodes a picture URL into an ImageBitmap, as the App decodes screencast frames. */
async function decode(src: string): Promise<ImageBitmap> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return createImageBitmap(image, { resizeWidth: 416, resizeHeight: 260 });
}

/** One page decoded once into an ImageBitmap (a decision's static tab frame); the still until it decodes. */
export function useDemoFrame(page: string): LiveTabFrameSource {
  const [frame, setFrame] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (typeof createImageBitmap !== "function") return undefined;
    let alive = true;
    let shown: ImageBitmap | null = null;
    void decode(page).then((bitmap) => {
      if (!alive) { bitmap.close(); return; }
      shown = bitmap;
      setFrame(bitmap);
    }).catch(() => undefined);
    return () => { alive = false; shown?.close(); };
  }, [page]);
  return frame ?? page;
}

/**
 * A stand-in screencast: alternates two pages as ImageBitmaps every `everyMs`
 * and closes each bitmap once the next one is shown (the App's frame rule).
 */
export function useDemoStream(pages: readonly string[], everyMs: number): LiveTabFrameSource | null {
  const [frame, setFrame] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    if (typeof createImageBitmap !== "function") return undefined;
    let alive = true;
    let index = 0;
    let shown: ImageBitmap | null = null;
    const next = () => void decode(pages[index++ % pages.length]!).then((bitmap) => {
      if (!alive) { bitmap.close(); return; }
      const previous = shown;
      shown = bitmap;
      setFrame(bitmap);
      queueMicrotask(() => previous?.close());
    }).catch(() => undefined);
    next();
    const timer = window.setInterval(next, everyMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [pages, everyMs]);
  return frame;
}
