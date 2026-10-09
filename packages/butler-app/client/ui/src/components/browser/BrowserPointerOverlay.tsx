import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPointer, setReducedMotionOverride, type AgentPointerProps } from "@/butler-ds";
import { getAppCopy, type AppLocale } from "../../../../../../butler-i18n/src/index";
import "@/butler-ds/tokens.css";

type Frame = AgentPointerProps & { locale: AppLocale };
declare global { interface Window { butlerBrowserOverlay?: { subscribe: (handler: (frame: Frame) => void) => () => void } } }

/** Pure presentation renderer: no stores, credentials, page DOM or tool ingress. */
function BrowserPointerOverlay() {
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => window.butlerBrowserOverlay?.subscribe((next) => {
    setReducedMotionOverride(next.reducedMotion === true);
    document.documentElement.lang = next.locale;
    setFrame(next);
  }), []);
  if (!frame) return null;
  const copy = getAppCopy(frame.locale).browser;
  return <AgentPointer {...frame} labels={{ butler: copy.pointerButler, looking: copy.pointerLooking, typing: copy.pointerTyping,
    waiting: copy.pointerWaiting, awaitingApproval: copy.pointerAwaitingApproval, needInput: copy.pointerNeedInput }} />;
}
createRoot(document.getElementById("root")!).render(<BrowserPointerOverlay />);
