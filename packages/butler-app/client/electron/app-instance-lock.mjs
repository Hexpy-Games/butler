import { join } from "node:path";
import { appDataRoots } from "./app-legacy-data.mjs";

/**
 * The App's single-instance lock, keyed by its data folder: two installs that
 * share one data folder (a Store package and a direct download) must not both
 * run. Electron keys the lock by the userData path at request time, so the
 * request uses a folder under the data root, then userData is restored for the
 * browser profile. A refused (legacy) data folder stays untouched and keeps
 * the userData key.
 */
export function requestAppSingleInstanceLock(app, writableRoot = appDataRoots().writableRoot) {
  if (!writableRoot) return app.requestSingleInstanceLock();
  const userData = app.getPath("userData");
  app.setPath("userData", join(writableRoot, "app", "runtime", "app-instance"));
  try { return app.requestSingleInstanceLock(); }
  finally { app.setPath("userData", userData); }
}
