import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** Loaded lazily by `useSyntaxHighlight`; keep the language set small. */
export const lowlight = createLowlight({
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  xml,
  yaml,
});

lowlight.registerAlias({
  bash: ["sh", "shell", "zsh", "console"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  markdown: ["md"],
  python: ["py"],
  rust: ["rs"],
  typescript: ["ts", "tsx", "mts", "cts"],
  xml: ["html", "svg"],
  yaml: ["yml"],
  diff: ["patch"],
});
