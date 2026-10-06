import { startMarkLoop } from "../../libs/design-system/components/ButlerThinkingMark/markLoop";
performance.mark("mark_start");
Object.assign(window, { startMarkLoop });
performance.mark("mark_end");
