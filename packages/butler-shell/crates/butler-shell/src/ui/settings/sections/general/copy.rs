//! The copy of Settings > General. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct GeneralCopy {
    /// settings.pageSections: languageRegion, conversationInput, sidebar, defaultPermission,
    /// notifications, notificationPermission, appBehavior, searchProvider, searchBehavior,
    /// fullReset
    pub(super) sections: [&'static str; 10],
    /// settings.pageSectionDescriptions: sidebar, notificationPermission, searchProvider,
    /// searchBehavior
    pub(super) section_descriptions: [&'static str; 4],
    /// settings.fields.language
    pub(super) language: &'static str,
    /// settings.fields.timezone
    pub(super) timezone: &'static str,
    /// settings.fields.followUpBehavior
    pub(super) follow_up: &'static str,
    /// settings.fields.multilineSend
    pub(super) multiline_send: &'static str,
    /// settings.fields.planModeDefault
    pub(super) plan_mode: &'static str,
    /// settings.fields.chatAccess
    pub(super) chat_access: &'static str,
    /// settings.fields.scheduleAccess
    pub(super) schedule_access: &'static str,
    /// settings.fields.commandSandbox
    pub(super) command_sandbox: &'static str,
    /// settings.fields.desktopTray
    pub(super) desktop_tray: &'static str,
    /// settings.fields.desktopNotifications, desktopNotificationAssistantMessages,
    /// desktopNotificationTaskCompletions
    pub(super) notifications: [&'static str; 3],
    /// settings.fields.searchProvider, searchProviderApiKey, searchReaderBackend,
    /// searchPlanningEnabled, searchDefaultDepth
    pub(super) search_fields: [&'static str; 5],
    /// settings.descriptions: language, timezone, chatAccess, scheduleAccess, commandSandbox,
    /// commandSandboxUnavailable, desktopTray
    pub(super) descriptions: [&'static str; 7],
    /// settings.descriptions.desktopNotifications, desktopNotificationAssistantMessages,
    /// desktopNotificationTaskCompletions
    pub(super) notification_descriptions: [&'static str; 3],
    /// settings.descriptions: searchProvider, searchProviderApiKeyConfigured,
    /// searchReaderBackend, searchPlanning
    pub(super) search_descriptions: [&'static str; 4],
    /// settings.descriptions.searchProviderApiKey
    pub(super) api_key: fn(&str) -> String,
    /// settings.options.english, korean
    pub(super) languages: [&'static str; 2],
    /// settings.options.queueWhileBusy, steerCurrentTurn
    pub(super) follow_ups: [&'static str; 2],
    /// settings.options.modifierEnterSendEnterNewline
    pub(super) modifier_enter: fn(&str) -> String,
    /// settings.options.enterSendShiftEnterNewline
    pub(super) enter_send: &'static str,
    /// settings.options.timezoneSearch, timezoneAll, timezoneEmpty
    pub(super) timezone_search: [&'static str; 3],
    /// settings.options.searchProviderDuckDuckGo, Auto, Brave, Tavily, OpenAi, ChatGpt, Disabled
    pub(super) providers: [&'static str; 7],
    /// settings.options.searchReaderBrowser, Lightweight, Auto, Lightpanda, Jina, Disabled
    pub(super) readers: [&'static str; 6],
    /// settings.options.searchDepthQuick, Balanced, Deep
    pub(super) depths: [&'static str; 3],
    /// interfaceDetails.smartGroups, smartGroupsDescription
    pub(super) smart_groups: [&'static str; 2],
    /// permissions.recommended
    pub(super) recommended: &'static str,
    /// interfaceDetails.default
    pub(super) default_mark: &'static str,
    /// settings.nativeNotifications.status.unsupported
    pub(super) notification_unsupported: &'static str,
    /// interfaceStatus.notificationStatus
    pub(super) notification_status: &'static str,
    /// interfaceStatus.unsupported
    pub(super) unsupported: &'static str,
    /// firstRun.rerunTitle, rerunDescription, rerunAction
    pub(super) rerun: [&'static str; 3],
    /// settings.fullReset.label, description, action
    pub(super) full_reset: [&'static str; 3],
    /// common.save
    pub(super) save: &'static str,
    /// shell.notYet
    pub(super) not_yet: &'static str,
}

static KO: GeneralCopy = GeneralCopy {
    sections: [
        "언어 및 지역",
        "대화 입력",
        "사이드바",
        "기본 권한",
        "알림",
        "알림 권한",
        "앱 동작",
        "검색 공급자",
        "검색 동작",
        "전체 초기화",
    ],
    section_descriptions: [
        "사이드바가 대화를 정리하는 방식입니다.",
        "운영체제 알림 권한을 확인하고 테스트 알림을 보냅니다.",
        "웹 검색 결과를 가져올 곳을 고릅니다. 키는 비밀값으로 저장합니다.",
        "버틀러가 검색 전에 페이지를 읽고 계획하는 방식입니다.",
    ],
    language: "언어",
    timezone: "시간대",
    follow_up: "후속 요청 처리",
    multiline_send: "메시지 보내기",
    plan_mode: "기본으로 계획 모드 사용",
    chat_access: "새 대화",
    schedule_access: "새 예약 작업",
    command_sandbox: "명령 격리",
    desktop_tray: "창을 닫아도 앱 아이콘 표시",
    notifications: ["데스크톱 알림", "AI 메시지 알림", "작업 완료 알림"],
    search_fields: [
        "검색 제공자",
        "API 키",
        "페이지 읽기",
        "스마트 검색계획 사용",
        "기본 검색 깊이",
    ],
    descriptions: [
        "버틀러 앱의 인터페이스 언어를 설정합니다",
        "버틀러가 현재 시간과 일정 맥락을 해석할 때 사용할 시간대입니다.",
        "새 대화가 이 권한으로 시작합니다. 대화마다 바꿀 수 있습니다.",
        "새 예약 작업이 이 권한으로 실행됩니다.",
        "알아서 진행할 때 파일을 바꾸는 명령을 격리된 환경에서 실행합니다. 끄면 실행 전에 확인합니다.",
        "이 기기에서는 사용할 수 없습니다",
        "켜면 창을 닫아도 앱이 계속 실행되며, 메뉴에서 새 대화와 최근 대화를 열 수 있습니다.",
    ],
    notification_descriptions: [
        "앱이 뒤에 있을 때 새 답변이나 작업 완료 상태를 운영체제 알림으로 보냅니다.",
        "새 AI 답변이 도착하면 안전한 미리보기만 알림에 표시합니다.",
        "진행 중인 작업이 완료, 실패, 취소 상태가 되면 알림을 보냅니다.",
    ],
    search_descriptions: [
        "실제 검색 결과를 가져올 백엔드를 선택합니다. 키가 필요한 제공자는 키가 없으면 안전한 기본 검색으로 내려갑니다.",
        "저장된 키 있음. 새 값을 입력하면 교체됩니다.",
        "검색 결과 원문을 읽을 때 사용할 페이지 리더입니다.",
        "켜면 검색 전에 모델을 한 번 호출해 의도, 깊이, 검증 필요성, 쿼리 묶음을 계획합니다. 형식 오류가 나면 한 번 재시도한 뒤 직접 검색합니다.",
    ],
    api_key: |env| format!("{env}에 저장합니다. 값은 화면과 API 응답에 다시 노출하지 않습니다."),
    languages: ["영어", "한국어"],
    follow_ups: ["작업 중이면 대기열에 추가", "현재 작업 방향 조정"],
    modifier_enter: |modifier| format!("{modifier} Enter 전송, Enter 줄바꿈"),
    enter_send: "Enter 전송, Shift Enter 줄바꿈",
    timezone_search: ["시간대 검색", "전체", "일치하는 시간대가 없습니다"],
    providers: [
        "DuckDuckGo HTML",
        "자동",
        "Brave Search",
        "Tavily",
        "OpenAI 웹 검색",
        "ChatGPT 플랜 검색",
        "비활성화",
    ],
    readers: [
        "버틀러 브라우저",
        "경량 리더",
        "자동",
        "Lightpanda",
        "Jina 호스팅",
        "비활성화",
    ],
    depths: ["빠르게", "균형", "깊게"],
    smart_groups: [
        "스마트 그룹",
        "새 대화를 같은 주제의 그룹으로 자동 정리합니다. 직접 옮긴 대화는 그대로 둡니다.",
    ],
    recommended: "권장",
    default_mark: "기본",
    notification_unsupported: "이 환경에서는 데스크톱 알림을 지원하지 않습니다.",
    notification_status: "OS 알림 상태",
    unsupported: "지원 안 함",
    rerun: [
        "설정 다시 실행",
        "동의와 AI 연결을 다시 봅니다. 모델과 대화는 그대로 둡니다.",
        "다시 실행",
    ],
    full_reset: [
        "모든 데이터 지우기",
        "채팅부터 기억까지 모두 지우고 처음부터 시작합니다.",
        "초기화",
    ],
    save: "저장",
    not_yet: "준비 중",
};

static EN: GeneralCopy = GeneralCopy {
    sections: [
        "Language & region",
        "Conversation input",
        "Sidebar",
        "Default permission",
        "Notifications",
        "Notification permission",
        "App behavior",
        "Search provider",
        "Search behavior",
        "Reset everything",
    ],
    section_descriptions: [
        "How the sidebar organizes conversations.",
        "Check the operating system permission and send a test notification.",
        "Choose where web search results come from. Keys are stored as secrets.",
        "How Butler reads pages and plans searches before running them.",
    ],
    language: "Language",
    timezone: "Time zone",
    follow_up: "Follow-up handling",
    multiline_send: "Message sending",
    plan_mode: "Use plan mode by default",
    chat_access: "New chats",
    schedule_access: "New schedules",
    command_sandbox: "Command sandbox",
    desktop_tray: "Keep app available after closing the window",
    notifications: [
        "Desktop notifications",
        "AI message notifications",
        "Task completion notifications",
    ],
    search_fields: [
        "Search provider",
        "API key",
        "Page reader",
        "Use smart search planning",
        "Default search depth",
    ],
    descriptions: [
        "Sets the Butler App interface language.",
        "The time zone Butler uses to understand current time and schedule context.",
        "New chats start with this. Change it in any chat.",
        "New schedules run with this permission.",
        "In Auto, commands that change files run in a sandbox. When off, Butler asks first.",
        "Not available on this device",
        "Keep the app running when its window is closed. Its menu provides quick access to new and recent chats.",
    ],
    notification_descriptions: [
        "Send OS notifications for new replies or task completion when the app is in the background.",
        "Show only a safe preview when a new AI reply arrives.",
        "Notify when an active task completes, fails, or is cancelled.",
    ],
    search_descriptions: [
        "Choose the backend that fetches search results. Providers without required keys fall back safely.",
        "A saved key exists. Enter a new value to replace it.",
        "The page reader used for search result pages.",
        "When enabled, Butler calls the model once before search to plan intent, depth, verification needs, and query batches.",
    ],
    api_key: |env| {
        format!("Stores the value in {env}. It is not shown again in the UI or API responses.")
    },
    languages: ["English", "Korean"],
    follow_ups: ["Queue while busy", "Steer current turn"],
    modifier_enter: |modifier| format!("{modifier} Enter sends, Enter inserts a newline"),
    enter_send: "Enter sends, Shift Enter inserts newline",
    timezone_search: ["Search time zones", "All", "No matching time zones"],
    providers: [
        "DuckDuckGo HTML",
        "Auto",
        "Brave Search",
        "Tavily",
        "OpenAI Web Search",
        "ChatGPT plan search",
        "Disabled",
    ],
    readers: [
        "Butler browser",
        "Lightweight reader",
        "Auto",
        "Lightpanda",
        "Jina Hosted",
        "Disabled",
    ],
    depths: ["Quick", "Balanced", "Deep"],
    smart_groups: [
        "Smart groups",
        "Automatically organize new conversations by topic. Manually moved conversations stay where you put them.",
    ],
    recommended: "Recommended",
    default_mark: "Default",
    notification_unsupported: "Desktop notifications are not supported in this environment.",
    notification_status: "OS notification status",
    unsupported: "Unsupported",
    rerun: [
        "Run setup again",
        "Review consent and your AI connection. Models and chats stay.",
        "Run again",
    ],
    full_reset: [
        "Erase all data",
        "Erase everything, from chats to memory, and start fresh.",
        "Reset",
    ],
    save: "Save",
    not_yet: "Coming soon",
};

pub(super) fn words(lang: Lang) -> &'static GeneralCopy {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
