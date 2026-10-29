import { api } from "@/app/api";
import { isGeneralChat } from "@/app/isGeneralChat";

let lastSent = -Infinity;
/** Called only by draft edits; no timer or idle renewal. */
export function sendComposingLease(sessionId: string, text: string): void {
  if (!isGeneralChat(sessionId) || !text.trim()) return;
  const now = performance.now();
  if (now - lastSent < 4000) return;
  lastSent = now;
  void api(`/sessions/${encodeURIComponent(sessionId)}/composing`, { method: "POST", body: "{}" }).catch(() => undefined);
}
