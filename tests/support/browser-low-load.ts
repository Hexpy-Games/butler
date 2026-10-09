import { loadavg } from "node:os";

/** Performance gates are only measured in the explicitly qualified load window. */
export async function waitBrowserLowLoad() {
  if (process.env.BUTLER_BROWSER_PERF_REPORT_ONLY === "1") return loadavg()[0];
  while(loadavg()[0]>=4)await new Promise(done=>setTimeout(done,30_000));
  return loadavg()[0];
}
