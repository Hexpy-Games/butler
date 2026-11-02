import type { GlossaryPart } from "./types";

export const schedules: GlossaryPart[] = [
  {
    id: "schedules",
    parent: null,
    area: "schedules",
    ko: "예약 작업 화면",
    en: "schedules page",
    desc: "정해진 시각과 조건으로 실행할 작업을 모읍니다.",
    ds: [],
    app: ["packages/butler-app/client/ui/src/components/management/AutomationsList.tsx"],
    avoid: [],
  },
  {
    id: "schedules.row",
    parent: "schedules",
    area: "schedules",
    ko: "예약 작업 행",
    en: "schedule row",
    desc: "예약 작업 이름과 다음 실행 시각을 표시합니다.",
    ds: [],
    app: ["packages/butler-app/client/ui/src/components/management/AutomationsList.tsx"],
    avoid: [],
  },
  {
    id: "schedules.editor",
    parent: "schedules",
    area: "schedules",
    ko: "예약 작업 편집 화면",
    en: "schedule editor",
    desc: "예약 시각·지시·권한·모델을 설정합니다.",
    ds: [],
    app: ["packages/butler-app/client/ui/src/components/management/AutomationForm.tsx", "packages/butler-app/client/ui/src/components/management/AutomationDetail.tsx"],
    avoid: [],
  },
];
