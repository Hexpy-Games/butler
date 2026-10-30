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

/** A request header that says it carries a sign-in. CSRF tokens go to anonymous
 * pages too, and cookies are read from the store. */
export function credentialHeader(name) {
  return credentialName(name) && !/csrf|xsrf|cookie/iu.test(name);
}

/** Whether a cookie says someone may be signed in. A false positive only costs an extra card. */
export function loginCookie(name, httpOnly, domain, isLocalHost) {
  if (name === NAMES.own_cookie && isLocalHost(domain)) return false;
  const lower = name.toLowerCase();
  return httpOnly || credentialName(name) || NAMES.cookie_substrings.some(needle => lower.includes(needle));
}

/** Whether a field's accessible name says a password goes in it. */
export function passwordField(name) {
  const lower = (name ?? "").toLowerCase();
  return NAMES.password_fields.some(needle => lower.includes(needle));
}
