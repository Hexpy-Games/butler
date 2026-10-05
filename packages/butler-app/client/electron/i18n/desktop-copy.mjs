/** Shared native-shell copy; usable by Electron without a TS loader. */
export function getDesktopCopy(language = "en") {
  return language.startsWith("ko") ? {
    quit: "버틀러를 종료하면 작업과 예약 작업이 중지됩니다.",
    cancel: "취소", quitButton: "버틀러 종료",
    unknown: "실행 중인 작업을 확인할 수 없습니다.",
    stopping: "실행 중인 작업을 중지합니다.", startAtLogin: "로그인 시 시작",
    quitting: "Butler 종료 중…", quitSaving: "진행 중인 작업을 저장합니다…",
    quitEmbedding: "임베딩 작업을 정리합니다…", quitStorage: "저장소를 닫습니다…",
    quitConnections: "연결을 닫습니다…", quitServices: "서비스를 정리합니다…",
    quitFinishing: "종료를 마무리합니다…", quitSlow: "종료가 예상보다 오래 걸립니다.",
    quitFailed: "종료를 완료하지 못했습니다. 안전하게 대기합니다.",
  } : {
    quit: "Quitting Butler stops work and schedules.",
    cancel: "Cancel", quitButton: "Quit Butler",
    unknown: "Could not check running work.",
    stopping: "Running work will stop.", startAtLogin: "Start at login",
    quitting: "Quitting Butler…", quitSaving: "Saving running work…",
    quitEmbedding: "Stopping embedding work…", quitStorage: "Closing storage…",
    quitConnections: "Closing connections…", quitServices: "Stopping services…",
    quitFinishing: "Finishing shutdown…", quitSlow: "Shutdown is taking longer than expected.",
    quitFailed: "Shutdown could not finish. Waiting safely.",
  };
}
