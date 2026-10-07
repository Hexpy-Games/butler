import { loadavg } from "node:os";

/** Performance gates are only measured in the explicitly qualified load window. */
export async function waitBrowserLowLoad() {
  while(loadavg()[0]>=4)await new Promise(done=>setTimeout(done,30_000));
  return loadavg()[0];
}
