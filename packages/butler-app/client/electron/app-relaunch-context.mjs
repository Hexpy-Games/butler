/** The preload URL is runtime state; only an original override survives relaunch. */
export function restoreLaunchServerEnvironment(explicitServerUrl, env = process.env) {
  if (explicitServerUrl) env.BUTLER_APP_SERVER_URL = explicitServerUrl;
  else delete env.BUTLER_APP_SERVER_URL;
}
export async function prepareStartupRetry(supervisor, explicitServerUrl) {
  await supervisor.stop({ wait: true, preserveWork: true, reason: "startup_retry" });
  restoreLaunchServerEnvironment(explicitServerUrl);
}
