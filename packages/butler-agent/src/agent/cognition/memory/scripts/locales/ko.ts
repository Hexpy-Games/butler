import type { LocalePatterns } from "./types.ts";

const ko: LocalePatterns = {
  decision: [/결정/g, /채택/g, /선택/g, /대신/g],
  concept: [
    /(\w+)이란\s+(.{5,60})/g,
    /(\w+)란\s+(.{5,60})/g,
  ],
  interest: [/궁금/g, /배우/g, /공부/g, /관심/g],
};

export default ko;
