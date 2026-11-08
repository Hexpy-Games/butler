//! The copy of the Updates page. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.updateComponents.app
    pub(super) app: &'static str,
    /// settings.pageSections.updateVersions
    pub(super) versions: &'static str,
    /// settings.pageSections.updateChannel
    pub(super) channel: &'static str,
    /// settings.actions.checkUpdates
    pub(super) check: &'static str,
    /// settings.actions.receivePreviewVersions
    pub(super) receive_previews: &'static str,
    /// settings.actions.receivePreviewVersionsDescription
    pub(super) receive_previews_description: &'static str,
    /// settings.actions.updateComponent
    pub(super) update: &'static str,
    /// settings.actions.upToDate
    pub(super) up_to_date: &'static str,
    /// settings.actions.updateChecking
    pub(super) checking: &'static str,
    /// settings.actions.updateUnavailable
    pub(super) unavailable: &'static str,
    /// settings.actions.updateApplying
    pub(super) applying: &'static str,
    /// settings.actions.updateDeferred
    pub(super) update_deferred: &'static str,
    /// settings.actions.updateAfterWork
    pub(super) update_after_work: &'static str,
    /// settings.errors.loadUpdates
    pub(super) load_failed: &'static str,
    /// settings.errors.checkUpdates
    pub(super) check_failed: &'static str,
    /// settings.errors.applyUpdate
    pub(super) apply_failed: &'static str,
    /// settings.updateProgress.verifying
    pub(super) verifying: &'static str,
    /// settings.updateProgress.restarting
    pub(super) restarting: &'static str,
    /// settings.updateProgress.ready
    pub(super) ready: &'static str,
    /// settings.updateProgress.downloading
    pub(super) downloading: &'static str,
    /// settings.updateProgress.retry
    pub(super) retry: &'static str,
    /// settings.updateProgress.cancel
    pub(super) cancel: &'static str,
    /// settings.updateProgress.restart
    pub(super) restart: &'static str,
    /// settings.updateProgress.downloadMeta
    pub(super) download_meta: &'static str,
    /// settings.updateProgress.downloadedBytes
    pub(super) downloaded_bytes: &'static str,
    /// settings.updateProgress.cancelled
    pub(super) cancelled: &'static str,
    /// settings.updateErrors.download
    pub(super) error_download: &'static str,
    /// settings.updateErrors.damaged
    pub(super) error_damaged: &'static str,
    /// settings.updateErrors.incompatible
    pub(super) error_incompatible: &'static str,
    /// settings.updateErrors.storage
    pub(super) error_storage: &'static str,
    /// settings.updateErrors.apply
    pub(super) error_apply: &'static str,
    /// settings.updateErrors.generic
    pub(super) error_generic: &'static str,
    /// The unit spacing of `Intl` megabyte short: "5 MB" in English, "5MB" in Korean.
    pub(super) megabyte: &'static str,
}

const KO: Words = Words {
    app: "버틀러",
    versions: "버전",
    channel: "업데이트 채널",
    check: "확인",
    receive_previews: "미리보기 버전 받기",
    receive_previews_description: "정식 출시 전 버전을 업데이트로 받습니다.",
    update: "업데이트",
    up_to_date: "최신",
    checking: "확인 중",
    unavailable: "최신 정보를 확인할 수 없음",
    applying: "적용 중",
    update_deferred: "작업이 끝나면 자동으로 업데이트합니다.",
    update_after_work: "작업이 끝나면 업데이트",
    load_failed: "업데이트 정보 불러오기 실패",
    check_failed: "업데이트 확인 실패",
    apply_failed: "업데이트 적용 실패",
    verifying: "파일 확인 중",
    restarting: "다시 시작하는 중",
    ready: "다시 시작하면 적용됩니다.",
    downloading: "다운로드 중",
    retry: "다시 시도",
    cancel: "취소",
    restart: "다시 시작",
    download_meta: "{percent}% · {done} / {total}",
    downloaded_bytes: "{done} 받음",
    cancelled: "다운로드를 취소했습니다.",
    error_download: "업데이트를 받지 못했습니다. 연결을 확인해 주세요.",
    error_damaged: "받은 파일을 확인하지 못했습니다. 다시 받아 주세요.",
    error_incompatible: "이 기기용 업데이트가 아직 없습니다.",
    error_storage: "업데이트 파일을 저장하지 못했습니다.",
    error_apply: "적용하지 못해 지금 버전을 유지합니다.",
    error_generic: "업데이트하지 못했습니다.",
    megabyte: "MB",
};

const EN: Words = Words {
    app: "Butler App",
    versions: "Versions",
    channel: "Update channel",
    check: "Check",
    receive_previews: "Receive preview versions",
    receive_previews_description: "Get versions before their stable release.",
    update: "Update",
    up_to_date: "Up to date",
    checking: "Checking",
    unavailable: "Can't check",
    applying: "Applying",
    update_deferred: "Butler will update automatically when work finishes.",
    update_after_work: "Update after work finishes",
    load_failed: "Failed to load update info",
    check_failed: "Failed to check updates",
    apply_failed: "Failed to apply update",
    verifying: "Verifying",
    restarting: "Restarting",
    ready: "Restart to finish.",
    downloading: "Downloading",
    retry: "Retry",
    cancel: "Cancel",
    restart: "Restart",
    download_meta: "{percent}% · {done} of {total}",
    downloaded_bytes: "{done} downloaded",
    cancelled: "Download cancelled.",
    error_download: "Couldn't download the update. Check your connection.",
    error_damaged: "The download didn't verify. Try again.",
    error_incompatible: "No update for this device yet.",
    error_storage: "Couldn't save the update file.",
    error_apply: "Couldn't apply it. Your current version stays.",
    error_generic: "Couldn't update.",
    megabyte: " MB",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
