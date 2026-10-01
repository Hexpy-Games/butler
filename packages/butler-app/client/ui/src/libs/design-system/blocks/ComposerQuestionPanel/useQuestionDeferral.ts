import { useEffect, useRef, useState, type RefObject } from "react";
import { animateMotion, motionDistance } from "../../lib/motion";

/** Keep the surface visible through the DS exit fade before the caller replaces it. */
export function useQuestionDeferral(panel: RefObject<HTMLDivElement | null>, onCollapse: () => void) {
  const [deferring, setDeferring] = useState(false);
  const animation = useRef<Animation | null>(null);
  const pending = useRef(false);
  useEffect(() => () => { pending.current = false; animation.current?.cancel(); }, []);
  const defer = () => {
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
      onCollapse();
      exit?.cancel();
      setDeferring(false);
    };
    if (exit) void exit.finished.then(finish).catch(() => undefined);
    else finish();
  };
  return { defer, deferring };
}
