export async function quitAndInstallAppUpdate({
  readActiveWork,
  confirmQuit,
  stopForUpdate,
  quitAndInstall,
}) {
  const snapshot = await readActiveWork();
  if (!(await confirmQuit(snapshot))) {
    return {
      status: "cancelled",
      update_started: false,
      raw_text_included: false,
    };
  }
  const stopResult = await stopForUpdate(snapshot);
  if (stopResult?.update_ready !== true) {
    return {
      status: "drain_failed",
      update_started: false,
      drain: stopResult?.drain ?? null,
      raw_text_included: false,
    };
  }
  quitAndInstall();
  return {
    status: "update_started",
    update_started: true,
    raw_text_included: false,
  };
}
