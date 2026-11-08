//! The preparation copy (`firstRun.*`). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.prepWorking
    pub(super) working: &'static str,
    /// firstRun.prepReady
    pub(super) ready: &'static str,
    /// firstRun.prepFailed
    pub(super) failed: &'static str,
    /// firstRun.moreActions
    pub(super) more: &'static str,
    /// firstRun.repair
    pub(super) repair: &'static str,
    /// firstRun.copyReport
    pub(super) copy_report: &'static str,
    /// firstRun.reportCopied
    pub(super) report_copied: &'static str,
    /// firstRun.reportUnavailable
    pub(super) report_unavailable: &'static str,
    /// firstRun.quit
    pub(super) quit: &'static str,
    /// firstRun.prepReasons.*; the first entry is `default`.
    reasons: &'static [(&'static str, &'static str)],
    /// firstRun.prepSteps.*
    steps: &'static [(&'static str, &'static str)],
}

impl Words {
    /// `prepReasons[code] ?? prepReasons.default`
    pub(super) fn reason(&self, code: &str) -> &'static str {
        self.reasons
            .iter()
            .find(|(key, _)| *key == code)
            .or(self.reasons.first())
            .map_or("", |(_, text)| text)
    }

    /// `prepSteps[id]`
    pub(super) fn step(&self, id: &str) -> Option<&'static str> {
        self.steps
            .iter()
            .find(|(key, _)| *key == id)
            .map(|(_, text)| *text)
    }
}

const KO: Words = Words {
    working: "버틀러 준비 중",
    ready: "준비됨",
    failed: "버틀러를 시작하지 못했습니다.",
    more: "더보기",
    repair: "초기화 후 다시 시작",
    copy_report: "문제 보고용 정보 복사",
    report_copied: "복사했습니다.",
    report_unavailable: "복사하지 못했습니다.",
    quit: "종료",
    reasons: &[
        ("default", "백그라운드 서비스가 응답하지 않습니다."),
        (
            "service_registration_unavailable",
            "백그라운드 서비스 실행이 허용되지 않았습니다.",
        ),
        ("agent_service_failed", "백그라운드 서비스가 멈췄습니다."),
        (
            "bundled_agent_version_missing",
            "버틀러 구성 요소가 없습니다. 다시 설치해 주세요.",
        ),
        (
            "gateway_profile_mismatch",
            "다른 버틀러가 백그라운드 서비스를 쓰고 있습니다.",
        ),
        (
            "data_folder_unwritable",
            "데이터 폴더(~/.butler)에 쓸 수 없습니다.",
        ),
        ("model_config_unreadable", "모델 설정을 읽을 수 없습니다."),
        (
            "agent_runtime_not_ready",
            "버틀러가 시작을 마치지 못했습니다.",
        ),
        (
            "agent_runtime_unreadable",
            "버틀러가 시작을 마치지 못했습니다.",
        ),
        (
            "data_folder_timed_out",
            "데이터 폴더를 확인하는 데 너무 오래 걸렸습니다.",
        ),
        (
            "model_config_timed_out",
            "모델 설정을 읽는 데 너무 오래 걸렸습니다.",
        ),
        (
            "agent_runtime_timed_out",
            "버틀러를 시작하는 데 너무 오래 걸렸습니다.",
        ),
    ],
    steps: &[
        ("agent_service", "버틀러 에이전트 서비스"),
        ("agent_runtime", "버틀러 에이전트 실행"),
        ("managed_gateway", "버틀러 에이전트 연결"),
        ("bundled_agent_version", "에이전트 버전 확인"),
        ("local_auth", "로컬 인증 확인"),
        ("health", "상태 확인"),
        ("protocol", "프로토콜 확인"),
        ("gateway_profile", "데스크톱 연결 확인"),
        ("data_folder", "데이터 폴더"),
        ("model_config", "모델 설정"),
    ],
};

const EN: Words = Words {
    working: "Getting Butler ready",
    ready: "Ready",
    failed: "Butler couldn't start.",
    more: "More",
    repair: "Reset and restart",
    copy_report: "Copy info for a bug report",
    report_copied: "Copied.",
    report_unavailable: "Couldn't copy.",
    quit: "Quit",
    reasons: &[
        ("default", "The background service didn't respond."),
        (
            "service_registration_unavailable",
            "The background service isn't allowed to run.",
        ),
        ("agent_service_failed", "The background service stopped."),
        (
            "bundled_agent_version_missing",
            "Part of Butler is missing. Reinstall Butler.",
        ),
        (
            "gateway_profile_mismatch",
            "Another Butler is using the background service.",
        ),
        (
            "data_folder_unwritable",
            "Butler can't write to its data folder (~/.butler).",
        ),
        (
            "model_config_unreadable",
            "Butler can't read its model settings.",
        ),
        ("agent_runtime_not_ready", "Butler didn't finish starting."),
        ("agent_runtime_unreadable", "Butler didn't finish starting."),
        (
            "data_folder_timed_out",
            "Checking the data folder took too long.",
        ),
        (
            "model_config_timed_out",
            "Reading the model settings took too long.",
        ),
        ("agent_runtime_timed_out", "Butler took too long to start."),
    ],
    steps: &[
        ("agent_service", "Butler Agent service"),
        ("agent_runtime", "Start Butler Agent"),
        ("managed_gateway", "Connect to Butler Agent"),
        ("bundled_agent_version", "Check Agent version"),
        ("local_auth", "Check local sign-in"),
        ("health", "Check status"),
        ("protocol", "Check protocol"),
        ("gateway_profile", "Check desktop connection"),
        ("data_folder", "Data folder"),
        ("model_config", "Model settings"),
    ],
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
