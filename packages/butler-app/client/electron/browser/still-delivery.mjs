import { stepStill } from "./stills.mjs";

/** Captures precede the next input; uploads never hold an action acknowledgement. */
export function enqueueStill(tab, index, epoch, deliver) {
  const entry = { promise: null };
  const owner = tab.owner, holder = tab.holder;
  const current = () => tab.epoch === epoch && tab.owner === owner && tab.holder === holder;
  const jobs = tab.stillJobs ??= new Set();
  jobs.add(entry);
  const capture = Promise.resolve(tab.stillCapture).then(async () => {
    if (!current()) return { reason: "document_changed" };
    if (tab.stills === false) return { reason: "stills_disabled" };
    const still = await stepStill(tab);
    return still && current() ? { still } : { reason: "capture_unavailable" };
  }).catch(() => ({ reason: "capture_failed" }));
  tab.stillCapture = capture.then(() => {});
  entry.promise = capture.then(outcome => deliver?.({ step: index, ...outcome })).catch(async () => {
    // If even the failure cannot reach the gateway, its durable marker remains
    // pending until reattachment/restart records why evidence was lost.
    await deliver?.({ step: index, reason: "upload_failed" }).catch(() => {});
  }).finally(() => { jobs.delete(entry); tab.onStillChanged?.(); });
  tab.onStillChanged?.();
}

/** Close fences further input and joins the active act and its entire still queue. */
export async function drainStills(tab, until = performance.now() + 1500) {
  tab.cancelled = true;
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, until - performance.now())); });
  try {
    await Promise.race([(async () => {
      await Promise.resolve(tab.activeAct).catch(() => {});
      while (tab.stillJobs?.size) await Promise.all([...tab.stillJobs].map(job => job.promise));
    })(), deadline]);
  } finally { clearTimeout(timer); }
}
