import type { GlossaryArea, GlossaryPart } from "./types";
import { window } from "./window";
import { sidebar } from "./sidebar";
import { conversation } from "./conversation";
import { composer } from "./composer";
import { session_info } from "./session-info";
import { browser } from "./browser";
import { file_viewer } from "./file-viewer";
import { settings } from "./settings";
import { project } from "./project";
import { canon } from "./canon";
import { schedules } from "./schedules";
import { library } from "./library";
import { overlays } from "./overlays";

export const areas: GlossaryArea[] = [
  { "id": "window", "ko": "버틀러 창", "en": "butler window" },
  { "id": "sidebar", "ko": "사이드바", "en": "sidebar" },
  { "id": "conversation", "ko": "대화 영역", "en": "conversation column" },
  { "id": "composer", "ko": "컴포저", "en": "composer" },
  { "id": "session-info", "ko": "세션 정보 패널", "en": "session info pane" },
  { "id": "browser", "ko": "브라우저 영역", "en": "browser column" },
  { "id": "file-viewer", "ko": "미리보기", "en": "preview" },
  { "id": "settings", "ko": "설정 화면", "en": "settings screen" },
  { "id": "project", "ko": "프로젝트 대시보드", "en": "project dashboard" },
  { "id": "canon", "ko": "과제 보드", "en": "task board" },
  { "id": "schedules", "ko": "예약 작업 화면", "en": "schedules page" },
  { "id": "library", "ko": "서랍 화면", "en": "library page" },
  { "id": "overlays", "ko": "오버레이", "en": "overlays" },
];

export const parts: GlossaryPart[] = [
  ...window,
  ...sidebar,
  ...conversation,
  ...composer,
  ...session_info,
  ...browser,
  ...file_viewer,
  ...settings,
  ...project,
  ...canon,
  ...schedules,
  ...library,
  ...overlays,
];
