import { traceRibbon } from "../src/libs/design-system/components/ButlerThinkingMark/thinking-mark/ribbon-geometry";
import { CENTER, DESIGN_SIZE, RHO, RING_R, RING_W } from "../src/libs/design-system/components/ButlerThinkingMark/thinking-mark/constants";
import { inkForButlerMarkTheme } from "../src/libs/design-system/components/ButlerThinkingMark/butlerMarkTheme";

/** Serialize the DS's exact rest geometry; the existing canvas owns subsequent motion. */
export function lifecycleRestMark() {
  let path = "";
  const point = (x: number, y: number) => `${x.toFixed(4)} ${y.toFixed(4)}`;
  traceRibbon({
    beginPath() { path = ""; },
    moveTo(x, y) { path += `M${point(x, y)}`; },
    lineTo(x, y) { path += `L${point(x, y)}`; },
    arc(x, y, radius, start, end, ccw) {
      path += `L${point(x + radius * Math.cos(start), y + radius * Math.sin(start))}`;
      path += `A${radius} ${radius} 0 0 ${ccw ? 0 : 1} ${point(x + radius * Math.cos(end), y + radius * Math.sin(end))}`;
    },
    closePath() { path += "Z"; },
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN_SIZE} ${DESIGN_SIZE}" data-slot="mark-rest" data-light="${inkForButlerMarkTheme("light")}" data-dark="${inkForButlerMarkTheme("dark")}" aria-hidden="true"><path d="${path}" fill="currentColor" stroke="currentColor" stroke-width="${RHO * 2}" stroke-linejoin="round"/><circle cx="${CENTER}" cy="${CENTER}" r="${RING_R}" fill="none" stroke="currentColor" stroke-width="${RING_W}"/></svg>`;
}
