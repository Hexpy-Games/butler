const defaultDrainAttempts = 25;
const defaultDrainDelayMs = 200;

export async function drainAppForegroundActiveWork({
  snapshot,
  cancelTurn,
  cancelWorker,
  readSnapshot,
  attempts = defaultDrainAttempts,
  delayMs = defaultDrainDelayMs,
  sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (snapshot?.classification === "no_active_work") {
    return drainResult("not_needed", 0, 0, true);
  }
  const turnIds = uniqueIds(snapshot?.turn_ids);
  const workerIds = uniqueIds(snapshot?.worker_ids);
  const results = await Promise.allSettled([
    ...turnIds.map((turnId) => cancelTurn(turnId)),
    ...workerIds.map((workerId) => cancelWorker(workerId)),
  ]);
  const requested = results.filter((result) => result.status === "fulfilled").length;
  const failed = results.length - requested;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await readSnapshot();
    if (current?.classification === "no_active_work") {
      return drainResult(
        failed === 0 ? "settled" : "settled_with_request_errors",
        requested,
        failed,
        true,
      );
    }
    if (attempt + 1 < maxAttempts) await sleepMs(delayMs);
  }
  return drainResult("deadline_exceeded", requested, failed, false);
}

function uniqueIds(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => safeId(item))
      .filter(Boolean),
  )];
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value)
    ? value
    : null;
}

function drainResult(status, requested, failed, settled) {
  return {
    status,
    cancellation_requests: requested,
    cancellation_failures: failed,
    settled,
    raw_text_included: false,
  };
}
