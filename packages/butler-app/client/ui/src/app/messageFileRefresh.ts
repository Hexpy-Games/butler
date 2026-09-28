import { api } from "./api.ts";
import { rememberSignedFileUrls } from "./messageFileUrls.ts";
import { isServerBackedSessionId } from "./sessionIds.ts";

type LoadJson = (path: string) => Promise<unknown>;

const inFlight = new Map<string, Promise<void>>();

/**
 * Re-reads a session's latest view (messages, attachments, artifacts) so its
 * message files get fresh signed URLs. Concurrent callers share one request;
 * failures are swallowed (the caller's load simply stays failed).
 */
export function refreshSessionFileUrls(
  sessionId: string,
  load: LoadJson = (path) => api(path),
): Promise<void> {
  if (!sessionId.trim() || !isServerBackedSessionId(sessionId)) {
    return Promise.resolve();
  }
  const running = inFlight.get(sessionId);
  if (running) return running;
  const query = new URLSearchParams({ session_id: sessionId });
  const request = load(`/session-view?${query.toString()}`)
    .then(rememberSignedFileUrls, () => undefined)
    .finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, request);
  return request;
}
