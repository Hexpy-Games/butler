//! The memory step's copy (KO/EN), each field naming its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.memoryChoice.title
    pub(super) title: &'static str,
    /// firstRun.memoryChoice.lede
    pub(super) lede: &'static str,
    /// firstRun.memoryChoice.on
    pub(super) on: &'static str,
    /// firstRun.memoryChoice.off
    pub(super) off: &'static str,
    /// firstRun.memoryChoice.offDescription
    pub(super) off_description: &'static str,
    /// firstRun.memoryChoice.continue
    pub(super) continue_: &'static str,
    /// firstRun.prepWorking
    pub(super) prep_working: &'static str,
    /// firstRun.memoryChoice.saveFailed
    pub(super) save_failed: &'static str,
    /// firstRun.memoryModel.description() without a size
    pub(super) description: &'static str,
    /// firstRun.memoryModel.downloading
    pub(super) downloading: &'static str,
    /// firstRun.memoryModel.verifying
    pub(super) verifying: &'static str,
    /// firstRun.memoryModel.failed
    pub(super) failed: &'static str,
    /// firstRun.memoryModel.retry
    pub(super) retry: &'static str,
    /// firstRun.memoryModel.reasons: (reason code, text)
    pub(super) reasons: [(&'static str, &'static str); 6],
    /// firstRun.memoryModel.reasons.default
    pub(super) reason_default: &'static str,
}

const KO: Words = Words {
    title: "대화를 어떻게 기억할까요?",
    lede: "나중에 설정 → 기억에서 바꿀 수 있습니다.",
    on: "기억 모델 사용",
    off: "사용 안 함",
    off_description: "기본 기억만 씁니다",
    continue_: "계속",
    prep_working: "버틀러 준비 중",
    save_failed: "선택을 저장하지 못했습니다",
    description: "대화를 더 잘 찾습니다",
    downloading: "기억 모델 받는 중",
    verifying: "기억 모델 확인 중",
    failed: "기억 모델을 받지 못했습니다",
    retry: "다시 시도",
    reasons: [
        ("embed_asset_download_failed", "연결을 확인해 주세요."),
        ("embed_asset_unavailable", "저장 공간을 확인해 주세요."),
        ("embed_asset_hash_mismatch", "파일을 확인하지 못했습니다."),
        (
            "embed_asset_range_invalid",
            "다운로드 응답을 읽지 못했습니다.",
        ),
        ("embed_asset_path_unsafe", "저장 경로를 확인해 주세요."),
        ("embed_asset_version_conflict", "모델 캐시를 확인해 주세요."),
    ],
    reason_default: "잠시 후 다시 시도해 주세요.",
};

const EN: Words = Words {
    title: "How should Butler remember?",
    lede: "You can change this later in Settings → Memory.",
    on: "Use memory model",
    off: "Don't use it",
    off_description: "Basic memory only",
    continue_: "Continue",
    prep_working: "Getting Butler ready",
    save_failed: "Couldn't save the choice",
    description: "Finds chats better",
    downloading: "Downloading memory model",
    verifying: "Verifying memory model",
    failed: "Couldn't download the memory model",
    retry: "Retry",
    reasons: [
        ("embed_asset_download_failed", "Check the connection."),
        ("embed_asset_unavailable", "Check storage."),
        ("embed_asset_hash_mismatch", "Couldn't verify the file."),
        (
            "embed_asset_range_invalid",
            "Couldn't read the download response.",
        ),
        ("embed_asset_path_unsafe", "Check the cache path."),
        ("embed_asset_version_conflict", "Check the model cache."),
    ],
    reason_default: "Try again shortly.",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
