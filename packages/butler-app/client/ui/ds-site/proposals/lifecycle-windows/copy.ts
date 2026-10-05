import type { ProposalLocale, QuitState, StartupState } from "./state";

/**
 * Window copy, mirrored as the proposed i18n keys (`lifecycle.*` in packages/butler-i18n, projected
 * into the static window at build time). Proposal-local only: nothing here ships.
 */
export interface WindowCopy {
  startupTitle: string;
  startupFailed: string;
  startupStages: Record<Exclude<StartupState, "slow" | "error">, string>;
  /** Failure reason by the stage that failed; the error state shows `engine`. */
  startupReasons: { engine: string; screen: string; data: string };
  quitTitle: string;
  quitFailed: string;
  quitStages: Record<Exclude<QuitState, "timeout" | "failed">, string>;
  forceHint: string;
  slow: string;
  retry: string;
  openLog: string;
  forceQuit: string;
}

export const WINDOW_COPY: Record<ProposalLocale, WindowCopy> = {
  "ko-KR": {
    startupTitle: "Butler 시작 중…",
    startupFailed: "Butler를 시작하지 못했습니다",
    startupStages: {
      prepare: "준비하는 중…",
      engine: "엔진을 시작하는 중…",
      screen: "화면을 준비하는 중…",
      upgrade: "데이터를 업데이트하는 중…",
      data: "데이터를 불러오는 중…",
    },
    startupReasons: {
      engine: "엔진이 응답하지 않습니다.",
      screen: "화면을 열지 못했습니다.",
      data: "데이터를 불러오지 못했습니다.",
    },
    quitTitle: "Butler 종료 중…",
    quitFailed: "Butler를 종료하지 못했습니다",
    quitStages: {
      saving: "작업을 저장하는 중…",
      search: "검색 데이터를 정리하는 중…",
      storage: "저장소를 닫는 중…",
      connections: "연결을 닫는 중…",
      services: "서비스를 정리하는 중…",
      finishing: "마무리하는 중…",
    },
    forceHint: "진행 중인 작업이 중단됩니다.",
    slow: "평소보다 오래 걸리고 있습니다.",
    retry: "다시 시도",
    openLog: "로그 열기",
    forceQuit: "강제 종료",
  },
  "en-US": {
    startupTitle: "Starting Butler…",
    startupFailed: "Butler couldn't start",
    startupStages: {
      prepare: "Getting ready…",
      engine: "Starting the engine…",
      screen: "Preparing the screen…",
      upgrade: "Updating your data…",
      data: "Loading your data…",
    },
    startupReasons: {
      engine: "The engine isn't responding.",
      screen: "Couldn't open the screen.",
      data: "Couldn't load your data.",
    },
    quitTitle: "Quitting Butler…",
    quitFailed: "Butler couldn't quit",
    quitStages: {
      saving: "Saving your work…",
      search: "Wrapping up search data…",
      storage: "Closing storage…",
      connections: "Closing connections…",
      services: "Stopping services…",
      finishing: "Finishing up…",
    },
    forceHint: "Work in progress will stop.",
    slow: "Taking longer than usual.",
    retry: "Try again",
    openLog: "Open log",
    forceQuit: "Force quit",
  },
};

/** Proposed i18n keys, in the order the spec lists them. */
export const I18N_KEYS: Array<[key: string, path: (copy: WindowCopy) => string]> = [
  ["lifecycle.startup.title", (c) => c.startupTitle],
  ["lifecycle.startup.stage.prepare", (c) => c.startupStages.prepare],
  ["lifecycle.startup.stage.engine", (c) => c.startupStages.engine],
  ["lifecycle.startup.stage.screen", (c) => c.startupStages.screen],
  ["lifecycle.startup.stage.upgrade", (c) => c.startupStages.upgrade],
  ["lifecycle.startup.stage.data", (c) => c.startupStages.data],
  ["lifecycle.startup.failed", (c) => c.startupFailed],
  ["lifecycle.startup.reason.engine", (c) => c.startupReasons.engine],
  ["lifecycle.startup.reason.screen", (c) => c.startupReasons.screen],
  ["lifecycle.startup.reason.data", (c) => c.startupReasons.data],
  ["lifecycle.quit.title", (c) => c.quitTitle],
  ["lifecycle.quit.stage.saving", (c) => c.quitStages.saving],
  ["lifecycle.quit.stage.search", (c) => c.quitStages.search],
  ["lifecycle.quit.stage.storage", (c) => c.quitStages.storage],
  ["lifecycle.quit.stage.connections", (c) => c.quitStages.connections],
  ["lifecycle.quit.stage.services", (c) => c.quitStages.services],
  ["lifecycle.quit.stage.finishing", (c) => c.quitStages.finishing],
  ["lifecycle.quit.failed", (c) => c.quitFailed],
  ["lifecycle.quit.forceHint", (c) => c.forceHint],
  ["lifecycle.slow", (c) => c.slow],
  ["lifecycle.action.retry", (c) => c.retry],
  ["lifecycle.action.openLog", (c) => c.openLog],
  ["lifecycle.action.forceQuit", (c) => c.forceQuit],
];

interface PageCopy {
  eyebrow: string;
  title: string;
  intro: string;
  variant: string;
  variants: { card: string; strip: string };
  recommended: string;
  width: string;
  widths: { desktop: string; "768": string; "375": string };
  theme: string;
  themes: { light: string; dark: string };
  wallpaper: string;
  none: string;
  backdrop: string;
  backdrops: { still: string; poster: string };
  motion: string;
  motions: { auto: string; reduced: string };
  language: string;
  startup: string;
  quit: string;
  play: string;
  startupStates: Record<StartupState, string>;
  quitStates: Record<QuitState, string>;
  realWindow: string;
  realWindowBody: string;
  notesTitle: string;
  notes: { card: string; strip: string };
  rulesTitle: string;
  rules: string[];
  keysTitle: string;
  gifTitle: string;
  gifCurrent: string;
  gifProposed: string;
  gifLive: string;
  gifVerdict: string;
  gifPlan: string[];
}

export const PAGE_COPY: Record<ProposalLocale, PageCopy> = {
  "en-US": {
    eyebrow: "Proposal · #480 #481",
    title: "Lifecycle windows",
    intro: "A tiny static window opens first on launch and again while Butler quits. The wallpaper still fills the window; the mark and the status sit on a tinted-glass card, never on the art.",
    variant: "Variant",
    variants: { card: "A · Card", strip: "B · Strip" },
    recommended: "Recommended",
    width: "Page width",
    widths: { desktop: "Desktop", "768": "768", "375": "375" },
    theme: "Theme",
    themes: { light: "Light", dark: "Dark" },
    wallpaper: "Wallpaper",
    none: "None",
    backdrop: "Backdrop",
    backdrops: { still: "Window-size still", poster: "Today's poster" },
    motion: "Motion",
    motions: { auto: "Auto", reduced: "Reduced" },
    language: "Language",
    startup: "Startup window",
    quit: "Quit window",
    play: "Play",
    startupStates: { prepare: "Prepare", engine: "Engine", screen: "Screen", upgrade: "Upgrade", data: "Data", slow: "Slow", error: "Error" },
    quitStates: { saving: "Saving", search: "Search", storage: "Storage", connections: "Connections", services: "Services", finishing: "Finishing", timeout: "Timeout", failed: "Failed" },
    realWindow: "Open as a real window",
    realWindowBody: "From the repo root, after building the DS site. Arrow keys switch states, T theme, W wallpaper, V variant, L language, M motion, P play, Q quit.",
    notesTitle: "Variants",
    notes: {
      card: "Centered card, 360×240. Shows the most wallpaper, so the handoff to the main window reads as one scene. Error actions fit without resizing the window.",
      strip: "Row layout, 400×176. Closer to today's quit window and less intrusive, but only a frame of wallpaper shows and long Korean stage lines truncate sooner.",
    },
    rulesTitle: "Behaviour",
    rules: [
      "Stage lines roll with RollingSwap; a line stays at least 600 ms so fast stages never flicker. The window itself has no minimum duration.",
      "Slow: after 8 s in one stage (tuned from host timings) a caption appears. Error: the mark settles to the logo; Try again relaunches, Open log reveals the diagnostics file.",
      "Quit: Timeout appears after 15 s and keeps the stage line live; Force quit needs a new supervisor path and owner approval. Failed replaces today's 'waiting safely'.",
      "Native window colour is the still's average colour, set before first paint; the window shows only after the still and the mark are decoded.",
      "Ships as one prerendered static HTML: this exact DS markup and CSS, captured at build time, plus the 9 KB DS mark engine and a tiny state script. No React, no app bundle.",
      "The still is the user's own wallpaper: the app renders it with the wallpaper engine at window size whenever the wallpaper or theme changes, and built-in stills cover a first launch.",
    ],
    keysTitle: "Proposed i18n keys",
    gifTitle: "Windows installer GIF (#481)",
    gifCurrent: "Current (codex)",
    gifProposed: "Proposed",
    gifLive: "Live DS mark on the same schedule",
    gifVerdict: "Right engine and ink, but the loop ends mid-settle (the last frame differs from the first by about 680 px, a visible pop), it starts morphing on frame one, and it has 1-bit transparency with near-black ink, which is jagged and almost invisible on a dark desktop.",
    gifPlan: [
      "192×192, opaque light DS surface tile with the app-icon corner radius; transparent only outside the corners.",
      "Mark canvas 168 px centred (ring about 69% of the tile, like the app icon), light inks in both Windows themes.",
      "20 fps: 0.5 s logo hold, 2.5 s working, then settle until the frame equals the logo (about 2.6 s). The generator asserts first frame = last frame.",
    ],
  },
  "ko-KR": {
    eyebrow: "제안 · #480 #481",
    title: "시작·종료 창",
    intro: "앱을 켤 때 가장 먼저, 그리고 종료하는 동안 작은 정적 창을 띄웁니다. 배경화면 스틸이 창을 채우고, 마크와 상태 문구는 배경 위가 아니라 틴티드 글래스 카드 위에 둡니다.",
    variant: "안",
    variants: { card: "A · 카드", strip: "B · 스트립" },
    recommended: "추천",
    width: "페이지 너비",
    widths: { desktop: "데스크톱", "768": "768", "375": "375" },
    theme: "테마",
    themes: { light: "라이트", dark: "다크" },
    wallpaper: "배경화면",
    none: "없음",
    backdrop: "배경 이미지",
    backdrops: { still: "창 크기 스틸", poster: "현재 포스터" },
    motion: "모션",
    motions: { auto: "자동", reduced: "줄이기" },
    language: "언어",
    startup: "시작 창",
    quit: "종료 창",
    play: "재생",
    startupStates: { prepare: "준비", engine: "엔진", screen: "화면", upgrade: "업데이트", data: "데이터", slow: "지연", error: "오류" },
    quitStates: { saving: "저장", search: "검색", storage: "저장소", connections: "연결", services: "서비스", finishing: "마무리", timeout: "시간 초과", failed: "실패" },
    realWindow: "실제 창으로 열기",
    realWindowBody: "DS 사이트를 빌드한 뒤 저장소 루트에서 실행합니다. 화살표 키로 상태, T 테마, W 배경화면, V 안, L 언어, M 모션, P 재생, Q 종료.",
    notesTitle: "안 비교",
    notes: {
      card: "가운데 카드, 360×240. 배경화면이 가장 많이 보여 메인 창으로 넘어갈 때 한 장면처럼 이어집니다. 오류 버튼이 들어가도 창 크기가 바뀌지 않습니다.",
      strip: "가로 배치, 400×176. 지금의 종료 창과 비슷하고 덜 거슬리지만 배경화면은 테두리만 보이고 긴 한국어 문구가 더 빨리 잘립니다.",
    },
    rulesTitle: "동작",
    rules: [
      "단계 문구는 RollingSwap으로 바뀌고, 한 줄은 최소 600ms 머물러 빠른 단계가 깜박이지 않습니다. 창 자체에는 최소 표시 시간이 없습니다.",
      "지연: 한 단계에서 8초(호스트 측정으로 조정)가 지나면 캡션이 나타납니다. 오류: 마크가 로고로 멈추고, 다시 시도는 재실행, 로그 열기는 진단 파일을 보여 줍니다.",
      "종료: 15초가 지나면 시간 초과 상태가 되고 단계 문구는 계속 갱신됩니다. 강제 종료는 새 supervisor 경로와 소유자 승인이 필요합니다. 실패는 지금의 '안전하게 대기합니다'를 대체합니다.",
      "네이티브 창 색은 첫 페인트 전에 스틸의 평균 색으로 지정하고, 스틸과 마크 디코딩이 끝난 뒤에만 창을 보여 줍니다.",
      "빌드할 때 이 DS 마크업과 CSS를 그대로 캡처한 정적 HTML 하나로 배포하고, 9KB짜리 DS 마크 엔진과 작은 상태 스크립트만 더합니다. React와 앱 번들은 쓰지 않습니다.",
      "스틸은 사용자의 실제 배경화면입니다. 배경화면이나 테마가 바뀔 때 앱이 배경화면 엔진으로 창 크기 스틸을 그려 두고, 첫 실행은 내장 스틸로 채웁니다.",
    ],
    keysTitle: "제안 i18n 키",
    gifTitle: "Windows 설치 GIF (#481)",
    gifCurrent: "현재 (codex)",
    gifProposed: "제안",
    gifLive: "같은 일정으로 움직이는 실제 DS 마크",
    gifVerdict: "엔진과 잉크는 맞지만, 루프가 되돌아오는 도중에 끝나(마지막 프레임과 첫 프레임이 약 680px 다름) 이음매에서 튀고, 첫 프레임부터 변형이 시작되며, 1비트 투명도에 거의 검은 잉크라 가장자리가 거칠고 어두운 바탕화면에서는 거의 보이지 않습니다.",
    gifPlan: [
      "192×192, 앱 아이콘과 같은 모서리 반경의 불투명 라이트 DS 서피스 타일. 모서리 바깥만 투명.",
      "마크 캔버스 168px 가운데 배치(링이 타일의 약 69%, 앱 아이콘과 같은 비율), Windows 테마와 관계없이 라이트 잉크.",
      "20fps: 로고 0.5초 유지, 작업 2.5초, 이후 프레임이 로고와 같아질 때까지 복귀(약 2.6초). 생성 스크립트가 첫 프레임 = 마지막 프레임을 확인합니다.",
    ],
  },
};
