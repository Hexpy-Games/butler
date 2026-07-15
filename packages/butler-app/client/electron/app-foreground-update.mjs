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
  await stopForUpdate(snapshot);
  quitAndInstall();
  return {
    status: "update_started",
    update_started: true,
    raw_text_included: false,
  };
}
