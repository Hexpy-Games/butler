import { appCopy } from "./copy.ts";
import type { SessionSummary } from "./types.ts";

/** Stable channels have a localized identity, independent of stored chat titles. */
export function sessionDisplayTitle(session: SessionSummary): string {
  return session.id === "general" ? appCopy.space.general : session.title;
}
