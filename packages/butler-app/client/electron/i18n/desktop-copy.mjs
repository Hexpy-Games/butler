/** Shared native-shell copy; usable by Electron without a TS loader. */
export function getDesktopCopy(language = "en") {
  return language.startsWith("ko") ? {
    quit: "Butler를 종료하면 작업과 예약 작업이 중지됩니다.",
    cancel: "취소", quitButton: "Butler 종료",
    unknown: "실행 중인 작업을 확인할 수 없습니다.",
    stopping: "실행 중인 작업을 중지합니다.", startAtLogin: "로그인 시 시작",
  } : {
    quit: "Quitting Butler stops work and schedules.",
    cancel: "Cancel", quitButton: "Quit Butler",
    unknown: "Could not check running work.",
    stopping: "Running work will stop.", startAtLogin: "Start at login",
  };
}
