/** The preload URL is runtime state; only an original override survives relaunch. */
export function restoreLaunchServerEnvironment(explicitServerUrl, env = process.env) {
  if (explicitServerUrl) env.BUTLER_APP_SERVER_URL = explicitServerUrl;
  else delete env.BUTLER_APP_SERVER_URL;
}
/**
 * Retry always reaches the relaunch: an Agent that cannot take the graceful stop (no foreground
 * host or stdin) is stopped by signal instead; a relaunch that fails again shows its own reason.
 */
export async function prepareStartupRetry(supervisor, explicitServerUrl) {
  try {
    await supervisor.stop({ wait: true, preserveWork: true, reason: "startup_retry" });
  } catch {
    await supervisor.stop({ wait: true, reason: "startup_retry" });
  }
  restoreLaunchServerEnvironment(explicitServerUrl);
}
