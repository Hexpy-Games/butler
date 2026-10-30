import { createRequire } from "node:module";

/** One list with Rust (`butler-runtime/src/browser/devtools/names.rs` reads the same file). */
const NAMES = createRequire(import.meta.url)("./page/credential-names.json");

function words(name) {
  const found = [""];
  let lower = false;
  for (const ch of name) {
    if (!/[\p{L}\p{N}]/u.test(ch)) { found.push(""); lower = false; continue; }
    if (lower && ch !== ch.toLowerCase()) found.push("");
    lower = ch !== ch.toUpperCase();
    found[found.length - 1] += ch.toLowerCase();
  }
  return found;
}

export function credentialName(name) {
  const lower = name.toLowerCase();
  return NAMES.substrings.some(needle => lower.includes(needle))
    || lower.includes("auth") && !lower.includes("author")
    || lower.includes("authorization")
    || words(name).some(word => NAMES.words.includes(word));
}
