//! The copy of the App update coordinator. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.actions.updateDeferred
    pub(super) deferred: &'static str,
    /// settings.errors.applyUpdate
    pub(super) apply_failed: &'static str,
}

/// The choice dialog (`AppUpdateDialog`), which the shell's frame renders while the status is
/// `ChoiceRequired`.
pub(crate) struct DialogWords {
    /// settings.actions.updateChoice
    pub(crate) title: &'static str,
    /// settings.actions.updateCheckpoint
    pub(crate) body: &'static str,
    /// settings.actions.updateAfterWork
    pub(crate) later: &'static str,
    /// settings.actions.updateNow
    pub(crate) now: &'static str,
}

const KO: Words = Words {
    deferred: "작업이 끝나면 자동으로 업데이트합니다.",
    apply_failed: "업데이트 적용 실패",
};

const EN: Words = Words {
    deferred: "Butler will update automatically when work finishes.",
    apply_failed: "Failed to apply update",
};

const DIALOG_KO: DialogWords = DialogWords {
    title: "업데이트를 위해 재시작합니다.",
    body: "실행 중인 작업은 저장되며 재시작 후 재시도할 수 있습니다. 대기 입력은 이어서 처리합니다.",
    later: "작업이 끝나면 업데이트",
    now: "지금 업데이트",
};

const DIALOG_EN: DialogWords = DialogWords {
    title: "Restart to update Butler.",
    body: "Running work is saved for retry after restart. Queued messages will continue.",
    later: "Update after work finishes",
    now: "Update now",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

pub(crate) fn dialog_words(lang: Lang) -> &'static DialogWords {
    match lang {
        Lang::Ko => &DIALOG_KO,
        Lang::En => &DIALOG_EN,
    }
}
