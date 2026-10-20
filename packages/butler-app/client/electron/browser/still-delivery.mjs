import { stepStill } from "./stills.mjs";

/** Captures precede the next input; uploads never hold an action acknowledgement. */
export function enqueueStill(tab, index, epoch, deliver, settled = false, reason) {
  const entry = { promise: null };
  const owner = tab.owner, holder = tab.holder;
  const current = () => tab.epoch === epoch && tab.owner === owner && tab.holder === holder;
  const jobs = tab.stillJobs ??= new Set();
  jobs.add(entry);
  const capture = Promise.resolve(tab.stillCapture).then(async () => {
    if (reason) return { reason };
    if (!current()) return { reason: "document_changed" };
    if (tab.stills === false) return { reason: "stills_disabled" };
    const still = await stepStill(tab, settled);
    return still ? { still } : { reason: "capture_unavailable" };
  }).catch(() => ({ reason: "capture_failed" }));
  tab.stillCapture = capture.then(() => {});
  entry.promise = capture.then(async outcome => {
    // The transport owns durable bytes and retry; never replace pixels with a failure.
    entry.outcome = { step: index, ...outcome };
    await deliver?.(entry.outcome);
  }).catch(() => {}).finally(() => { jobs.delete(entry); tab.onStillChanged?.(); });
  tab.onStillChanged?.();
}

/** Every exit consumes the original step before its evidence owner can be replaced. */
export function settlePendingStill(tab, reason) {
  const evidence = tab.pendingStill;
  const step = (tab.pendingBatch ?? []).findLastIndex(step => step.reason === "dialog_pending");
  if (evidence && step >= 0) enqueueStill(tab, step, tab.epoch, evidence.deliver, true, reason);
  tab.pendingStill = null;
  tab.pendingBatch = null;
}

/** Close fences further input and joins the active act and its entire still queue. */
export async function drainStills(tab, until = performance.now() + 1500) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, until - performance.now())); });
  try {
    await Promise.race([(async () => {
      await Promise.resolve(tab.activeAct).catch(() => {});
      settlePendingStill(tab, "document_changed");
      while (tab.stillJobs?.size) await Promise.all([...tab.stillJobs].map(job => job.promise));
    })(), deadline]);
  } finally { clearTimeout(timer); }
}
