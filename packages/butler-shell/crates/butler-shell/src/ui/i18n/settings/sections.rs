//! settings.sections, settings.sectionDescriptions and settings.sectionAliases: one row per
//! settings page, in `SectionId` order (`visibleSettingsSectionIds` with developer mode on).
use butler_ds::ui::context::Lang;

/// One page's copy in one language.
pub(crate) struct Localized {
    /// settings.sections.<id>
    pub(crate) label: &'static str,
    /// settings.sectionDescriptions.<id>
    pub(crate) description: &'static str,
    /// settings.sectionAliases.<id>
    pub(crate) aliases: &'static [&'static str],
}

pub(crate) struct SectionCopy {
    pub(crate) id: &'static str,
    pub(crate) ko: Localized,
    pub(crate) en: Localized,
}

impl SectionCopy {
    pub(crate) fn of(&self, lang: Lang) -> &Localized {
        match lang {
            Lang::Ko => &self.ko,
            Lang::En => &self.en,
        }
    }
}

const fn row(id: &'static str, ko: Localized, en: Localized) -> SectionCopy {
    SectionCopy { id, ko, en }
}

const fn copy(
    label: &'static str,
    description: &'static str,
    aliases: &'static [&'static str],
) -> Localized {
    Localized {
        label,
        description,
        aliases,
    }
}

pub(crate) static SETTINGS_SECTIONS: [SectionCopy; 17] = [
    row(
        "general",
        copy(
            "일반",
            "언어, 시간대, 대화 입력과 검색 기본값을 설정합니다.",
            &[
                "기본",
                "일반 설정",
                "대화",
                "스마트 그룹",
                "사이드바",
                "기본 권한",
                "전체 초기화",
            ],
        ),
        copy(
            "General",
            "Configure language, time zone, conversation input, and search defaults.",
            &[
                "basics",
                "general settings",
                "conversation",
                "smart groups",
                "sidebar",
                "default permission",
                "reset everything",
            ],
        ),
    ),
    row(
        "appearance",
        copy(
            "모양",
            "앱의 테마와 화면 표시 방식을 설정합니다.",
            &[
                "테마",
                "화면 설정",
                "디자인",
                "입력창",
                "컴포저",
                "대화창",
                "대화창 배경",
                "대화 배경",
                "배경 불투명도",
            ],
        ),
        copy(
            "Appearance",
            "Configure the app theme and display behavior.",
            &[
                "theme",
                "display",
                "design",
                "message box",
                "composer",
                "conversation",
                "conversation background",
                "chat background",
                "overlay",
            ],
        ),
    ),
    row(
        "personalization",
        copy(
            "개인화",
            "버틀러가 사용할 이름, 말투와 사용자 정보를 관리합니다.",
            &["사용자 정보", "페르소나", "말투"],
        ),
        copy(
            "Personalization",
            "Manage the name, tone, and personal settings Butler uses.",
            &["user profile", "persona", "tone"],
        ),
    ),
    row(
        "memory",
        copy(
            "기억",
            "버틀러가 기억하는 내용을 종류별로 관리합니다.",
            &[
                "지침",
                "대화 기억",
                "프로필",
                "프로젝트 기억",
                "초기화",
                "공간 정리",
                "저장 공간",
            ],
        ),
        copy(
            "Memory",
            "What Butler remembers, grouped by type.",
            &[
                "instructions",
                "chat memory",
                "profile",
                "project memory",
                "reset",
                "free up space",
                "storage",
            ],
        ),
    ),
    row(
        "models",
        copy(
            "모델",
            "버틀러 모델과 예비 모델을 설정합니다.",
            &[
                "이미지",
                "image",
                "모델 설정",
                "작업자",
                "예비 모델",
                "API 키",
            ],
        ),
        copy(
            "Models",
            "Choose Butler's model and backup models.",
            &[
                "이미지",
                "image",
                "model settings",
                "workers",
                "backup models",
                "api keys",
            ],
        ),
    ),
    row(
        "updates",
        copy(
            "업데이트",
            "버틀러를 확인하고 업데이트합니다.",
            &["업그레이드", "새 버전"],
        ),
        copy(
            "Updates",
            "Check and update Butler App.",
            &["upgrade", "new version"],
        ),
    ),
    row(
        "usage",
        copy(
            "사용량",
            "모델과 도구 사용량을 확인합니다.",
            &["토큰", "사용량"],
        ),
        copy(
            "Usage",
            "Review model and tool usage.",
            &["tokens", "telemetry"],
        ),
    ),
    row(
        "logs",
        copy(
            "로그",
            "기록 수준, 로그와 저장 공간을 관리합니다.",
            &["개발자 로그", "디버그", "기록 수준", "로그 내보내기"],
        ),
        copy(
            "Logs",
            "Manage the log level, logs and storage.",
            &["developer logs", "debug", "log level", "export logs"],
        ),
    ),
    row(
        "browser",
        copy(
            "브라우저",
            "로그인, 가져오기, 결제 수단을 관리합니다.",
            &[
                "browser",
                "signin",
                "로그인",
                "로그인 저장",
                "가져오기",
                "북마크",
                "비밀번호",
            ],
        ),
        copy(
            "Browser",
            "Manage sign-ins, imports and payment methods.",
            &[
                "브라우저",
                "sign-ins",
                "signin",
                "saved logins",
                "import",
                "bookmarks",
                "passwords",
            ],
        ),
    ),
    row(
        "security",
        copy(
            "보안",
            "접속, 권한과 키를 관리합니다.",
            &[
                "원격 접속",
                "연결 코드",
                "LAN",
                "네트워크",
                "허용 호스트",
                "터널",
                "권한",
                "허용한 작업",
                "API 키",
                "저장된 키",
                "개인정보",
            ],
        ),
        copy(
            "Security",
            "Manage access, permissions and keys.",
            &[
                "remote access",
                "connection code",
                "LAN",
                "network",
                "allowed hosts",
                "tunnel",
                "permissions",
                "approvals",
                "API keys",
                "saved keys",
                "privacy",
            ],
        ),
    ),
    row(
        "system",
        copy(
            "시스템 이벤트",
            "정기 정리와 유지보수 이벤트를 확인합니다.",
            &["유지보수", "기억 정리"],
        ),
        copy(
            "System events",
            "Review regular maintenance and system events.",
            &["maintenance", "memory consolidation"],
        ),
    ),
    row(
        "archives",
        copy(
            "아카이브",
            "보관한 프로젝트와 대화를 복원하거나 삭제합니다.",
            &["보관", "아카이브"],
        ),
        copy(
            "Archives",
            "Restore or delete archived projects and chats.",
            &["saved chats", "archive"],
        ),
    ),
    row(
        "about",
        copy(
            "정보",
            "버틀러 버전과 앱 정보를 확인합니다.",
            &["버전", "앱 정보", "진단", "진단 내보내기", "개발자 모드"],
        ),
        copy(
            "About",
            "View Butler version and app information.",
            &[
                "version",
                "app info",
                "diagnostics",
                "export diagnostics",
                "developer mode",
            ],
        ),
    ),
    row(
        "mcp",
        copy(
            "MCP",
            "MCP 서버와 연결 정보를 관리합니다.",
            &["도구 서버", "외부 도구"],
        ),
        copy(
            "MCP",
            "Manage MCP servers and their connection settings.",
            &["tool servers", "external tools"],
        ),
    ),
    row(
        "hooks",
        copy("훅", "명령으로 훅을 관리합니다.", &["hooks", "훅"]),
        copy(
            "Hooks",
            "Run your own commands on Butler events.",
            &["hooks", "훅"],
        ),
    ),
    row(
        "skills",
        copy(
            "스킬",
            "기본 스킬과 프로젝트 스킬을 관리합니다.",
            &["스킬 관리", "기능"],
        ),
        copy(
            "Skills",
            "Manage built-in and project skills.",
            &["skill management", "capabilities"],
        ),
    ),
    row(
        "server",
        copy(
            "서버",
            "버틀러 서버 연결과 새 프로젝트 폴더를 설정합니다.",
            &["연결", "프로젝트 폴더"],
        ),
        copy(
            "Server",
            "Configure the Butler server connection and new project folder.",
            &["connection", "project folder"],
        ),
    ),
];

/// The labels `settingsSearchAliases` assigns to the memory page (moved settings keep their
/// old search words there): settings.pageSections.noticedPatterns, settings.memory.proactiveLevel,
/// settings.memory.quietHours, settings.pageSections.memoryCleanup, settings.fields.consolidationTime,
/// settings.fields.consolidationModel.
pub(crate) fn memory_assigned(lang: Lang) -> &'static [&'static str; 6] {
    match lang {
        Lang::Ko => &[
            "버틀러가 알아챈 것",
            "먼저 말 걸기",
            "조용한 시간",
            "기억 정리",
            "실행 시간",
            "대화 기억 정리 모델",
        ],
        Lang::En => &[
            "What Butler noticed",
            "Reach out first",
            "Quiet hours",
            "Memory consolidation",
            "Time",
            "Chat memory model",
        ],
    }
}
