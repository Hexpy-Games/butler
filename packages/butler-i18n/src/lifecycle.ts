/** Static desktop windows project only these public copy keys at build time. */
export const lifecycleCopy = {
  ko: {
    startup: { title: "버틀러 시작 중…", failed: "버틀러를 시작하지 못했습니다",
      stage: { prepare: "준비하는 중…", service: "백그라운드 서비스를 시작하는 중…", screen: "화면을 준비하는 중…", upgrade: "데이터를 업데이트하는 중…", data: "데이터를 불러오는 중…" },
      reason: { service: "백그라운드 서비스가 응답하지 않습니다.", screen: "화면을 열지 못했습니다.", data: "데이터를 불러오지 못했습니다." } },
    quit: { title: "버틀러 종료 중…", failed: "버틀러를 종료하지 못했습니다", forceHint: "진행 중인 작업이 중단됩니다.",
      stage: { saving: "작업을 저장하는 중…", search: "검색 데이터를 정리하는 중…", storage: "저장소를 닫는 중…", connections: "연결을 닫는 중…", services: "서비스를 정리하는 중…", finishing: "마무리하는 중…" } },
    slow: "평소보다 오래 걸리고 있습니다.", action: { retry: "다시 시도", openLog: "로그 열기", forceQuit: "강제 종료" },
  },
  en: {
    startup: { title: "Starting Butler…", failed: "Butler couldn't start",
      stage: { prepare: "Getting ready…", service: "Starting the background service…", screen: "Preparing the screen…", upgrade: "Updating your data…", data: "Loading your data…" },
      reason: { service: "The background service didn't respond.", screen: "Couldn't open the screen.", data: "Couldn't load your data." } },
    quit: { title: "Quitting Butler…", failed: "Butler couldn't quit", forceHint: "Work in progress will stop.",
      stage: { saving: "Saving your work…", search: "Wrapping up search data…", storage: "Closing storage…", connections: "Closing connections…", services: "Stopping services…", finishing: "Finishing up…" } },
    slow: "Taking longer than usual.", action: { retry: "Try again", openLog: "Open log", forceQuit: "Force quit" },
  },
};
export type LifecycleCopy = typeof lifecycleCopy.en;
