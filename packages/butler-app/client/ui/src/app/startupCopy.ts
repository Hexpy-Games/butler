export const startupCopy = {
  ko: {
    starting: "버틀러를 준비합니다…", agent: "에이전트를 시작합니다…",
    migration: "이전 버전을 정리합니다…", renderer: "화면을 준비합니다…", failed: "시작하지 못했습니다.",
    retry: "다시 시도", logs: "로그 보기",
  },
  en: {
    starting: "Preparing Butler…", agent: "Starting agent…",
    migration: "Preparing upgrade…", renderer: "Preparing workspace…", failed: "Could not start Butler.",
    retry: "Retry", logs: "View logs",
  },
};
export type StartupStage = "starting" | "agent" | "migration" | "renderer";
