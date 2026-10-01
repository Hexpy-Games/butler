import { useEffect, useRef, useState, type RefObject } from "react";
import { animateMotion, motionDistance } from "./motion";

/** Keep the surface visible through the DS exit fade before the caller replaces it. */
export function useComposerPanelTransition(panel: RefObject<HTMLDivElement | null>, onCollapse?: () => void, visible = true) {
  const [deferring, setDeferring] = useState(false);
  const animation = useRef<Animation | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const node = visible ? panel.current : null;
    const enter = node && animateMotion(node, [
      { opacity: 0, transform: `translateY(${motionDistance("sm")}px)` },
      { opacity: 1, transform: "translateY(0)" },
    ], { duration: "base", easing: "decelerate" });
    return () => { pending.current = false; enter?.cancel(); animation.current?.cancel(); };
  }, [panel, visible]);
  const defer = (complete = onCollapse) => {
    if (pending.current) return;
    pending.current = true;
    setDeferring(true);
    const exit = panel.current && animateMotion(panel.current, [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: `translateY(${motionDistance("sm")}px)` },
    ], { duration: "exit-base", easing: "accelerate", fill: "forwards" });
    animation.current = exit;
    const finish = () => {
      if (!pending.current) return;
      pending.current = false;
      complete?.();
      exit?.cancel();
      setDeferring(false);
    };
    if (exit) void exit.finished.then(finish).catch(() => undefined);
    else finish();
  };
  return { defer, deferring };
}
