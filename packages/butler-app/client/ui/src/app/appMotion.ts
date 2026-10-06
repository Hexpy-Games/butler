import { setReducedMotionOverride } from "@/butler-ds";
import { useButlerStore } from "./store";

/** One change-driven subscription; unrelated store updates never touch the DOM. */
export function bindAppMotion(): void {
  let reduced = useButlerStore.getState().settings.reduce_motion;
  setReducedMotionOverride(reduced);
  let frame = 0;
  useButlerStore.subscribe((state) => {
    if (state.settings.reduce_motion === reduced) return;
    reduced = state.settings.reduce_motion;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setReducedMotionOverride(reduced));
  });
}
