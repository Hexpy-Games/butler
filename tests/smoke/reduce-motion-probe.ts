// Browser smoke fixture: runs the shipped DS helpers and canvas scheduler, no mocks.
import { animateMotion, motionDistance, prefersReducedMotion, subscribeReducedMotion } from "../../packages/butler-app/client/ui/src/libs/design-system/lib/motion";
import { pendingMarkFrames, startMarkLoop } from "../../packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/markLoop";

export function mountProbe() {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:48px;height:48px";
  document.body.append(canvas);
  const sim = { current: null };
  const loop = startMarkLoop(canvas, { isWorking: () => true, isReduced: prefersReducedMotion, sim });
  if (!loop) throw new Error("Canvas unavailable");
  const unsubscribe = subscribeReducedMotion(() => loop.start());
  return {
    read() {
      const animation = animateMotion(canvas, [
        { opacity: 0, transform: `translateY(${motionDistance("md")}px)` },
        { opacity: 1, transform: "translateY(0px)" },
      ]);
      const frames = (animation?.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
      const duration = animation?.effect?.getTiming().duration;
      animation?.cancel();
      return { reduced: prefersReducedMotion(), pending: pendingMarkFrames(), distance: motionDistance("md"), frames, duration };
    },
    dispose() { unsubscribe(); loop.dispose(); canvas.remove(); },
  };
}
