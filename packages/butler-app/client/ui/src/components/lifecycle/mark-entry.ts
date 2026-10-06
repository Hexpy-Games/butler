import { startMarkLoop } from "../../libs/design-system/components/ButlerThinkingMark/markLoop";
performance.mark("mark_start");
const canvas = document.querySelector<HTMLCanvasElement>('[data-slot="mark"]')!;
const rest = document.querySelector<SVGElement>('[data-slot="mark-rest"]')!;
const sim: Parameters<typeof startMarkLoop>[1]["sim"] = { current: null };
let loop: ReturnType<typeof startMarkLoop>;
let theme: string;
let working = false;
let reduced = false;
Object.assign(window, { updateMark(nextTheme: "light" | "dark", nextWorking: boolean, nextReduced: boolean) {
  working = nextWorking;
  reduced = nextReduced;
  if (!loop || theme !== nextTheme) {
    loop?.dispose();
    canvas.hidden = false;
    theme = nextTheme;
    loop = startMarkLoop(canvas, { theme: nextTheme, isWorking: () => working, isReduced: () => reduced, sim });
  }
  rest.toggleAttribute("hidden", !!loop);
  canvas.dataset.ready = loop ? "1" : "";
  canvas.dataset.breathe = reduced && working ? "on" : "";
  loop?.start();
} });
performance.mark("mark_end");
