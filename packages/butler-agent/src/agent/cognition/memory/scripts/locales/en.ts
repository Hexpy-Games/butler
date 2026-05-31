import type { LocalePatterns } from "./types.ts";

const en: LocalePatterns = {
  decision: [
    /decided/gi, /chose/gi, /went with/gi, /switched to/gi,
    /→\s*\w/g,
  ],
  concept: [
    /(\w+)\s+is\s+a\s+(.{5,60})/gi,
    /(\w+)\s+means\s+(.{5,60})/gi,
  ],
  interest: [
    /curious about/gi, /learning/gi, /interested in/gi,
  ],
};

export default en;
