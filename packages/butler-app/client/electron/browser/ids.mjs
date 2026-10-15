import { randomInt } from "node:crypto";

/** Short ids the model copies reliably: a letter plus six base-36 characters. */
export function shortId(prefix, taken = () => false) {
  for (;;) {
    const id = `${prefix}${randomInt(36 ** 6).toString(36).padStart(6, "0")}`;
    if (!taken(id)) return id;
  }
}
