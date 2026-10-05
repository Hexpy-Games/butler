import type { ProposalLocale, ReviewSection, StageState } from "./state";

// Proposal page text only. Settings UI inside the frame reads appCopy or proposedCopy.ts.

type Options<K extends keyof StageState> = Record<StageState[K] & string, string>;

interface Note { title: string; points: string[] }

export interface PageCopy {
  eyebrow: string;
  title: string;
  intro: string;
  sections: Options<"section">;
  controls: {
    width: string; theme: string; wallpaper: string; language: string; variant: string; state: string;
    failure: string; screen: string; error: string; placement: string;
  };
  widths: { desktop: string; "768": string; "375": string };
  themes: Options<"theme">;
  wallpapers: Options<"wallpaper">;
  update: Options<"update">;
  failure: Options<"failure">;
  updateVariant: Options<"updateVariant">;
  motionVariant: Options<"motionVariant">;
  motion: Options<"motion">;
  errorScreen: Options<"errorScreen">;
  mcpError: Options<"mcpError">;
  approvals: Options<"approvals">;
  updatePlace: Options<"updatePlace">;
  recommended: string;
  frameLabel: string;
  copyTable: string;
  copyColumns: { key: string; ko: string; en: string; codes: string };
  existing: string;
  notes: Record<ReviewSection, Note[]>;
}

const NOTES_EN: Record<ReviewSection, Note[]> = {
  updates: [
    { title: "Outside Settings: A · Sidebar row", points: [
      "What the shell has: the sidebar footer holds one row, Settings (SpaceSidebar footer). There is no version or account area, no app menu (Menu.setApplicationMenu(null)), and the titlebar's trailing buttons are … and the right-panel toggle. The tray menu exists only when the tray is on.",
      "A (recommended): a row above Settings, only while an update is running, ready or failed. Label + % badge + a bare ProgressMeter as its second line; Ready shows Restart in the row; tapping opens Settings › Updates. Room for words and the one action, no new chrome.",
      "B: a progress ring first in the titlebar buttons (tooltip with %). Visible with the sidebar closed, but tiny, no room for Restart, and crowds the 375 titlebar.",
      "C: a % badge on the existing Settings row. Smallest change, but a badge on Settings doesn't say what it is.",
      "With A, the window also shows native dock/taskbar progress (BrowserWindow.setProgressBar) so a collapsed sidebar or hidden window still shows it; no renderer UI.",
    ] },
    { title: "Row", points: [
      "Same row as main: name, version, one action button. The button only ever shows the action you can take now (Update, Cancel, Restart, Retry); the stage is never a button label.",
      "Known size: ProgressMeter under the row, 42% · 44 MB of 105 MB. Unknown size: no fake bar; a spinner line with the bytes received.",
      "Verifying and restarting are not cancellable, so they show a status line and no button.",
      "Failure: an error Notice under the row, mapped from the error code; Retry takes the action slot. Cancel is not a failure: the row returns to Update and a toast confirms.",
    ] },
    { title: "Fixed from codex/update-progress", points: [
      "Stage label shown twice (button and meter) → once, in the meter or status line.",
      "Idle panel 'Update idle' and 'Check complete' rendered as progress → nothing rendered when idle.",
      "1024-based KB/MB labelled as MB, not localized → Intl unit format, decimal MB.",
      "Speed line and 'Progress is unavailable.' sentence → removed; bytes received is enough.",
      "'Package checksum did not match.' → plain cause and next step.",
      "Cancel in its own ButtonContainer below → the row's action slot.",
    ] },
  ],
  motion: [
    { title: "Placement", points: [
      "A (recommended): its own Accessibility section right after Home screen. It is next to the wallpaper Motion switch but its title says it applies to the whole app.",
      "B: last field of Home screen. Closest, but reads as a wallpaper setting.",
      "C: between Theme and Translucent sidebar (codex branch). Far from the motion switch.",
      "While motion is reduced the wallpaper holds still, so Motion is shown off and disabled with a tooltip, and Pause on battery hides, as when Motion is off. With the OS setting on, the switch reads on, disabled, tooltip 'On in your system settings'.",
    ] },
    { title: "Why the codex branch measured 368 ms (budget 150 ms)", points: [
      "The smoke times the first Appearance open right after page.goto. startApp() now blocks the first render on GET /settings, so the app is still hydrating (navigation, wallpaper module compile) when the click lands. On main the perf smoke waits for Settings first.",
      "The toggle path does three synchronous things in one task: settings PATCH → setSettings (every settings subscriber re-renders), a data-motion attribute flip on <html> (full-document style recalc: @scope roots and --motion-* custom properties on :root), and every subscribeReducedMotion callback (wallpaper engine still-frame redraw, thinking mark loops) from one MutationObserver turn.",
      "Fix for Codex: see the spec in the final report (keep the switch optimistic, apply data-motion in a rAF after commit, scope the attribute to the shell instead of <html>, subscribe wallpaper engines to a single store signal, and measure toggle and open separately after settings are idle).",
    ] },
  ],
  errors: [
    { title: "Rules", points: [
      "A field the agent can reject shows its error under the control (FieldError, aria-invalid, aria-describedby, focus on first invalid). It clears on edit.",
      "Everything else is a one-line toast: what failed, never the server's message, never a code.",
      "The renderer maps error codes to keys. The agent sends a specific code per cause (MCP save today sends one code with an English sentence).",
    ] },
    { title: "Found on main", points: [
      "notifyError puts the raw server message in every toast's second line (app/notifications.ts:47).",
      "MCP save maps English messages, not codes (useMcpSettingsActions.ts:17); the agent collapses every cause into mcp_server_save_failed (application/mcp_servers.rs:19).",
      "Wallpaper module import toasts the gateway's first message line (hooks/useWallpaperModules.ts:53).",
      "Archive restore and Load more have no catch (ArchivesSettings.tsx:35, :49): silent failure.",
      "Settings save toast title 'Settings update failed' plus raw description (settingsUIStore.ts:256).",
      "Skill rows show the raw source id as meta ('user', 'core') (SkillGroup.tsx:28).",
    ] },
  ],
  approvals: [
    { title: "Security, reorganised", points: [
      "Order: Remote access · Device pairing · Paired devices (as today) → Permissions → Approved actions (new) → Saved keys → Diagnostics → Advanced · Allowed hosts (as today, last).",
      "Models › Permissions (access mode, plan mode default) → Security. Whole section, PermissionsFields unchanged.",
      "Models › Saved keys (SavedKeysRows, its states and replace/delete) → Security. Model add/edit still reads the same keys.",
      "Privacy › Diagnostics (its only section) → Security. The Privacy page leaves the sidebar; 'privacy' and 'diagnostics' become Security search aliases.",
      "Stay where they are: General › search API key (paired with the provider choice), MCP env/header secrets (part of each server's form), Server › connection URL, About › developer mode, Developer logs.",
      "On another computer /security is refused: only Remote access collapses to its message; the moved sections still render.",
    ] },
    { title: "List", points: [
      "Row: kind, exact target in monospace on one line (hover: full text; tap or Enter: expands in place), scope tag, where it applies, date, one revoke button.",
      "Identical grants (kind, target, folder, scope) collapse into one row: '2 chats'. Revoke removes every grant in the row.",
      "Always grants confirm first; others revoke at once with a toast. Search and a kind filter appear past 8 rows.",
      "The composer permission menu is unchanged: the three access modes only.",
    ] },
    { title: "Backend facts (grant storage)", points: [
      "Table btcc_conversation_permissions: grant_ref, owner_session_id, workspace_path, scope_key, title, description, created_at, revoked_at.",
      "API returns per conversation only: grant_ref, capability, target, cwd, title, description. created_at is stored but not returned; there is no list across conversations.",
      "Scope storage is 'once' | 'conversation' only. 'This project' and 'Always' have no storage today; the issue keeps storage unchanged, so they ship hidden until it exists.",
      "title/description are Korean strings built in Rust (permission.rs); the list derives copy from capability instead.",
    ] },
  ],
};

const NOTES_KO: Record<ReviewSection, Note[]> = {
  updates: [
    { title: "설정 밖: A · 사이드바 줄", points: [
      "현재 셸: 사이드바 아래에는 '설정' 한 줄만 있습니다(SpaceSidebar footer). 버전·계정 영역과 앱 메뉴는 없고(Menu.setApplicationMenu(null)), 제목줄 오른쪽 버튼은 …와 오른쪽 패널 토글입니다. 트레이 메뉴는 트레이를 켰을 때만 있습니다.",
      "A(추천): 업데이트가 진행 중·준비됨·실패일 때만 '설정' 위에 한 줄. 이름 + % 배지 + 둘째 줄 얇은 ProgressMeter, 준비되면 줄 안에 '다시 시작', 누르면 설정 › 업데이트. 말과 동작 하나를 둘 자리가 있고 새 크롬이 없습니다.",
      "B: 제목줄 버튼 맨 앞의 진행 링(툴팁에 %). 사이드바를 닫아도 보이지만 작고 '다시 시작'을 둘 자리가 없으며 375에서 제목줄이 좁아집니다.",
      "C: 기존 '설정' 줄에 % 배지. 변경이 가장 작지만 배지가 무엇인지 알 수 없습니다.",
      "A와 함께 창 자체에 네이티브 독·작업 표시줄 진행률(BrowserWindow.setProgressBar)을 표시합니다. 사이드바를 접거나 창을 숨겨도 보이며 화면 UI는 없습니다.",
    ] },
    { title: "행", points: [
      "main과 같은 행입니다: 이름, 버전, 동작 버튼 하나. 버튼에는 지금 할 수 있는 동작(업데이트, 취소, 다시 시작, 다시 시도)만 표시하고 단계 이름은 표시하지 않습니다.",
      "크기를 알면 행 아래 ProgressMeter: 42% · 44MB / 105MB. 모르면 가짜 막대 없이 스피너와 받은 용량만 표시합니다.",
      "파일 확인·다시 시작 중에는 취소할 수 없으므로 상태 줄만 두고 버튼은 숨깁니다.",
      "실패하면 행 아래 오류 Notice(오류 코드에 맞춘 문구)와 다시 시도 버튼. 취소는 실패가 아니므로 업데이트 버튼으로 돌아가고 토스트로 알립니다.",
    ] },
    { title: "codex/update-progress에서 고친 점", points: [
      "단계 이름이 버튼과 막대에 두 번 표시 → 한 번만.",
      "대기 상태에도 '업데이트 대기', '확인 완료' 패널 표시 → 대기 시 표시 안 함.",
      "1024 기준 값을 MB로 표기, 지역화 없음 → Intl 단위 형식, 10진 MB.",
      "속도 줄과 '진행률을 제공하지 않습니다.' 문장 → 삭제, 받은 용량으로 충분합니다.",
      "'체크섬이 일치하지 않습니다.' → 원인과 다음 행동을 쉬운 말로.",
      "취소 버튼이 아래 별도 줄 → 행의 동작 자리로.",
    ] },
  ],
  motion: [
    { title: "위치", points: [
      "A(추천): 홈 화면 바로 다음의 '접근성' 섹션. 월페이퍼 움직임 스위치 바로 아래이면서 앱 전체 설정임이 제목으로 드러납니다.",
      "B: 홈 화면 섹션의 마지막 필드. 가장 가깝지만 월페이퍼 설정처럼 읽힙니다.",
      "C: 테마와 투명 사이드바 사이(codex 브랜치). 움직임 스위치와 멉니다.",
      "동작을 줄이면 월페이퍼가 멈추므로 '움직임'은 꺼짐·비활성(툴팁)으로, '배터리 사용 시 멈춤'은 움직임이 꺼졌을 때처럼 숨깁니다. 시스템 설정이 켜져 있으면 스위치는 켜짐·비활성, 툴팁 '시스템 설정에서 켜져 있습니다'.",
    ] },
    { title: "codex 브랜치가 368ms(예산 150ms)인 이유", points: [
      "스모크가 page.goto 직후 첫 '모양' 열기를 잽니다. startApp()이 GET /settings까지 첫 렌더를 막아 클릭 시점에 앱이 아직 초기화 중(내비게이션, 월페이퍼 모듈 컴파일)입니다. main의 성능 스모크는 설정 화면이 뜬 뒤에 잽니다.",
      "토글 경로는 한 태스크에서 동기로 세 가지를 합니다: PATCH → setSettings(설정 구독자 전체 재렌더), <html>의 data-motion 변경(@scope 루트와 :root의 --motion-* 사용자 속성 때문에 문서 전체 스타일 재계산), MutationObserver 한 턴에서 모든 subscribeReducedMotion 콜백(월페이퍼 정지 프레임 다시 그리기, 생각 표시 루프).",
      "Codex용 수정안은 최종 보고의 스펙에 있습니다(스위치 즉시 반영, 커밋 후 rAF에서 data-motion 적용, <html> 대신 셸에 속성, 월페이퍼 엔진은 스토어 신호 하나 구독, 열기와 토글을 설정이 안정된 뒤 따로 측정).",
    ] },
  ],
  errors: [
    { title: "규칙", points: [
      "에이전트가 거절할 수 있는 필드는 컨트롤 아래에 오류를 표시합니다(FieldError, aria-invalid, aria-describedby, 첫 오류 필드에 포커스). 수정하면 사라집니다.",
      "나머지는 한 줄 토스트: 무엇이 실패했는지만. 서버 문장과 코드는 표시하지 않습니다.",
      "오류 코드 → i18n 키로 렌더러가 매핑합니다. 에이전트는 원인별 코드를 보냅니다(지금 MCP 저장은 코드 하나와 영어 문장).",
    ] },
    { title: "main에서 찾은 문제", points: [
      "notifyError가 모든 토스트 둘째 줄에 서버 원문을 넣습니다(app/notifications.ts:47).",
      "MCP 저장은 코드가 아닌 영어 문장으로 매핑합니다(useMcpSettingsActions.ts:17). 에이전트는 모든 원인을 mcp_server_save_failed 하나로 보냅니다(application/mcp_servers.rs:19).",
      "월페이퍼 모듈 가져오기 실패 시 게이트웨이 메시지 첫 줄을 그대로 토스트로 표시합니다(hooks/useWallpaperModules.ts:53).",
      "보관함 복원·더 보기에 catch가 없어 조용히 실패합니다(ArchivesSettings.tsx:35, :49).",
      "설정 저장 실패 토스트: '설정 업데이트 실패' + 서버 원문(settingsUIStore.ts:256).",
      "스킬 행의 meta에 내부 값('user', 'core')이 그대로 표시됩니다(SkillGroup.tsx:28).",
    ] },
  ],
  approvals: [
    { title: "보안 페이지 재구성", points: [
      "순서: 원격 접속 · 기기 연결 · 연결된 기기(지금 그대로) → 권한 → 허용한 작업(새로) → 저장된 키 → 진단 → 고급 · 허용 호스트(지금 그대로, 맨 끝).",
      "모델 › 권한(접근 권한, 계획 모드 기본값) → 보안. 섹션 전체, PermissionsFields 그대로.",
      "모델 › 저장된 키(SavedKeysRows, 상태와 교체·삭제) → 보안. 모델 추가·편집은 같은 키를 계속 씁니다.",
      "개인정보 › 진단(유일한 섹션) → 보안. 개인정보 페이지는 사이드바에서 빠지고 '개인정보', '진단'은 보안 검색어가 됩니다.",
      "그대로 두는 것: 일반 › 검색 API 키(검색 제공자와 한 쌍), MCP 환경 변수·헤더 비밀값(서버 양식의 일부), 서버 › 연결 URL, 정보 › 개발자 모드, 개발자 로그.",
      "다른 컴퓨터에서는 /security가 거절되므로 원격 접속만 안내 문구로 바뀌고, 옮긴 섹션은 그대로 보입니다.",
    ] },
    { title: "목록", points: [
      "행: 종류, 정확한 대상(고정폭 한 줄, 마우스를 올리면 전체, 탭·Enter로 펼침), 범위 태그, 적용 위치, 날짜, 해제 버튼 하나.",
      "같은 허용(종류·대상·폴더·범위)은 한 행으로 묶습니다: '대화 2개'. 해제하면 묶인 허용을 모두 해제합니다.",
      "'항상' 허용은 확인 후 해제하고, 나머지는 바로 해제한 뒤 토스트로 알립니다. 8개를 넘으면 검색과 종류 필터를 보여 줍니다.",
      "입력창의 권한 메뉴는 그대로입니다: 접근 모드 세 가지만.",
    ] },
    { title: "백엔드 사실(허용 저장소)", points: [
      "테이블 btcc_conversation_permissions: grant_ref, owner_session_id, workspace_path, scope_key, title, description, created_at, revoked_at.",
      "API는 대화별로만 반환합니다: grant_ref, capability, target, cwd, title, description. created_at은 저장되지만 반환되지 않고, 대화 전체 목록 API가 없습니다.",
      "범위 저장값은 'once' | 'conversation'뿐입니다. '이 프로젝트', '항상'은 저장소가 없습니다. 이슈가 저장소 변경을 막으므로 생길 때까지 숨깁니다.",
      "title/description은 Rust에서 만든 한국어 문자열입니다(permission.rs). 목록은 capability로 문구를 정합니다.",
    ] },
  ],
};

export const PAGE_COPY: Record<ProposalLocale, PageCopy> = {
  "en-US": {
    eyebrow: "Proposal · #483 · #519 · settings errors · reduce motion",
    title: "Settings review",
    intro: "Four Settings changes in the real Settings shell. Pick a section, then its state. Everything outside the marked proposal pieces is the product UI as it is on main.",
    sections: { updates: "Updates", motion: "Reduce motion", errors: "Errors", approvals: "Approvals" },
    controls: { width: "Width", theme: "Theme", wallpaper: "Wallpaper", language: "Language", variant: "Variant", state: "State", failure: "Failure", screen: "Screen", error: "Error", placement: "Outside Settings" },
    widths: { desktop: "Desktop", "768": "768", "375": "375" },
    themes: { light: "Light", dark: "Dark" },
    wallpapers: { clouds: "Clouds", daisies: "Daisies", bloom: "Bloom", none: "None" },
    update: { available: "Available", checking: "Checking", downloading: "Downloading", downloadingUnknown: "Size unknown", verifying: "Verifying", ready: "Ready", deferred: "After work", activating: "Restarting", failed: "Failed", upToDate: "Up to date" },
    failure: { download: "Network", damaged: "Damaged", incompatible: "No build", storage: "Storage", apply: "Apply", generic: "Other" },
    updateVariant: { proposal: "Proposal", codex: "codex branch" },
    motionVariant: { accessibility: "A · Accessibility", homeScreen: "B · Home screen", codex: "C · Theme (codex)" },
    motion: { off: "Off", on: "On", system: "OS on" },
    errorScreen: { mcp: "MCP form", skills: "Skill import", hosts: "Hosts (main)", wallpaper: "Wallpaper", toasts: "Toasts" },
    mcpError: { none: "None", idRequired: "ID empty", idInvalid: "ID invalid", commandRequired: "No command", urlRequired: "No URL", saveFailed: "Save failed" },
    approvals: { list: "List", long: "Long", empty: "Empty", loading: "Loading", error: "Error" },
    updatePlace: { settings: "Settings page", sidebarRow: "A · Sidebar row", titlebar: "B · Titlebar ring", settingsBadge: "C · Settings badge" },
    recommended: "Recommended",
    frameLabel: "Settings preview",
    copyTable: "Copy (i18n keys)",
    copyColumns: { key: "Key", ko: "KO", en: "EN", codes: "Error codes" },
    existing: "on main",
    notes: NOTES_EN,
  },
  "ko-KR": {
    eyebrow: "제안 · #483 · #519 · 설정 오류 · 동작 줄이기",
    title: "설정 검토",
    intro: "실제 설정 화면 안에서 네 가지 변경을 봅니다. 위에서 영역을 고르고 상태를 바꿔 보세요. 제안으로 표시한 부분 밖은 모두 main의 실제 화면입니다.",
    sections: { updates: "업데이트", motion: "동작 줄이기", errors: "오류", approvals: "허용한 작업" },
    controls: { width: "너비", theme: "테마", wallpaper: "배경화면", language: "언어", variant: "안", state: "상태", failure: "실패 원인", screen: "화면", error: "오류", placement: "설정 밖" },
    widths: { desktop: "데스크톱", "768": "768", "375": "375" },
    themes: { light: "라이트", dark: "다크" },
    wallpapers: { clouds: "구름", daisies: "데이지", bloom: "블룸", none: "없음" },
    update: { available: "업데이트 있음", checking: "확인 중", downloading: "다운로드 중", downloadingUnknown: "크기 모름", verifying: "파일 확인", ready: "준비됨", deferred: "작업 후", activating: "다시 시작", failed: "실패", upToDate: "최신" },
    failure: { download: "연결", damaged: "손상", incompatible: "빌드 없음", storage: "저장", apply: "적용", generic: "기타" },
    updateVariant: { proposal: "제안", codex: "codex 브랜치" },
    motionVariant: { accessibility: "A · 접근성", homeScreen: "B · 홈 화면", codex: "C · 테마(codex)" },
    motion: { off: "꺼짐", on: "켜짐", system: "시스템 켜짐" },
    errorScreen: { mcp: "MCP 양식", skills: "스킬 가져오기", hosts: "호스트(main)", wallpaper: "월페이퍼", toasts: "토스트" },
    mcpError: { none: "없음", idRequired: "ID 비어 있음", idInvalid: "ID 형식", commandRequired: "명령 없음", urlRequired: "URL 없음", saveFailed: "저장 실패" },
    approvals: { list: "목록", long: "긴 목록", empty: "비어 있음", loading: "불러오는 중", error: "오류" },
    updatePlace: { settings: "설정 화면", sidebarRow: "A · 사이드바 줄", titlebar: "B · 제목줄 링", settingsBadge: "C · 설정 배지" },
    recommended: "추천",
    frameLabel: "설정 미리보기",
    copyTable: "문구(i18n 키)",
    copyColumns: { key: "키", ko: "한국어", en: "영어", codes: "오류 코드" },
    existing: "main에 있음",
    notes: NOTES_KO,
  },
};
