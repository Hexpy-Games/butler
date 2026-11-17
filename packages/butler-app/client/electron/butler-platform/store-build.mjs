/**
 * The Store build: the Windows App running from an MSIX package. Windows owns
 * its read-only install folder, its updates, its start-at-login task and its
 * app identity. The one Store-build rule; the bundled Agent learns it through
 * BUTLER_APP_STORE_BUILD.
 */
export function isStoreBuild(proc = process) {
  return proc.platform === "win32" && proc.windowsStore === true;
}
