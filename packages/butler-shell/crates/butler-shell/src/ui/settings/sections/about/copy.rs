//! The About copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.pageSections.appInfo
    pub(super) app_info: &'static str,
    /// sessionInfo.experiments
    pub(super) experiments: &'static str,
    /// sessionInfo.enableGraph
    pub(super) enable_graph: &'static str,
    /// OpenSourceLicenses.tsx: the section title
    pub(super) licenses: &'static str,
    /// OpenSourceLicenses.tsx: the dialog title and its button
    pub(super) licenses_title: &'static str,
    /// settings.pageSections.diagnostics
    pub(super) diagnostics: &'static str,
    /// settings.pageSections.developer
    pub(super) developer: &'static str,
    /// settings.fields.appName, appVersion, appRepository, appProtocol
    pub(super) app_name: &'static str,
    pub(super) app_version: &'static str,
    pub(super) app_repository: &'static str,
    pub(super) app_protocol: &'static str,
    /// firstRun.product
    pub(super) product: &'static str,
    /// settings.fields.developerMode
    pub(super) developer_mode: &'static str,
    /// settings.descriptions.developerMode
    pub(super) developer_mode_description: &'static str,
    /// settings.errors.loadAppInfo
    pub(super) load_app_info: &'static str,
    /// settings.logs.diagnosticsLabel, diagnosticsDescription, diagnosticsExport
    pub(super) diagnostics_label: &'static str,
    pub(super) diagnostics_description: &'static str,
    pub(super) diagnostics_export: &'static str,
    /// settings.logs.exported, exportFailed
    pub(super) exported: &'static str,
    pub(super) export_failed: &'static str,
    /// shell.notYet
    pub(super) not_yet: &'static str,
}

const KO: Words = Words {
    app_info: "앱 정보",
    experiments: "실험 기능",
    enable_graph: "작업 그래프 사용하기",
    licenses: "라이선스",
    licenses_title: "오픈소스 라이선스",
    diagnostics: "진단",
    developer: "개발자",
    app_name: "앱 이름",
    app_version: "버전",
    app_repository: "GitHub 저장소",
    app_protocol: "프로토콜",
    product: "버틀러",
    developer_mode: "개발자 모드",
    developer_mode_description: "DevTools와 로그 화면을 켭니다.",
    load_app_info: "앱 정보 불러오기 실패",
    diagnostics_label: "로그 파일",
    diagnostics_description: "대화 내용 없이 저장합니다.",
    diagnostics_export: "진단 내보내기",
    exported: "내보냈습니다.",
    export_failed: "내보내지 못했습니다.",
    not_yet: "준비 중",
};

const EN: Words = Words {
    app_info: "App info",
    experiments: "Experiments",
    enable_graph: "Enable task graph",
    licenses: "Licenses",
    licenses_title: "Open source licenses",
    diagnostics: "Diagnostics",
    developer: "Developer",
    app_name: "App name",
    app_version: "Version",
    app_repository: "GitHub repository",
    app_protocol: "Protocol",
    product: "Butler",
    developer_mode: "Developer mode",
    developer_mode_description: "Turns on DevTools and the Logs page.",
    load_app_info: "Failed to load app info",
    diagnostics_label: "Log file",
    diagnostics_description: "Saved without chat content.",
    diagnostics_export: "Export diagnostics",
    exported: "Exported.",
    export_failed: "Couldn't export.",
    not_yet: "Coming soon",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
