//! The copy of the document page. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// documents.saved
    pub(super) saved: &'static str,
    /// documents.editing
    pub(super) editing: &'static str,
    /// documents.edited
    pub(super) edited: &'static str,
    /// documents.restore
    pub(super) restore: &'static str,
    /// documents.versions
    pub(super) versions: &'static str,
    /// documents.current
    pub(super) current: &'static str,
    /// documents.me
    pub(super) me: &'static str,
    /// documents.butler
    pub(super) butler: &'static str,
    /// documents.export
    pub(super) export: &'static str,
    /// documents.markdown
    pub(super) markdown: &'static str,
    /// documents.pdf
    pub(super) pdf: &'static str,
    /// documents.moreActions
    pub(super) more_actions: &'static str,
    /// documents.exportMarkdown
    pub(super) export_markdown: &'static str,
    /// documents.exportPdf
    pub(super) export_pdf: &'static str,
    /// documents.originalChat
    pub(super) original_chat: &'static str,
    /// library.undo
    pub(super) undo: &'static str,
    /// library.failed
    pub(super) failed: &'static str,
    /// artifacts.loading
    pub(super) loading: &'static str,
    /// shell.notYet
    pub(super) not_yet: &'static str,
}

static KO: Words = Words {
    saved: "저장됨",
    editing: "버틀러가 수정 중",
    edited: "버틀러가 수정했어요",
    restore: "되돌리기",
    versions: "버전 기록",
    current: "현재",
    me: "나",
    butler: "버틀러",
    export: "내보내기",
    markdown: "Markdown",
    pdf: "PDF",
    more_actions: "더보기",
    export_markdown: "Markdown으로 내보내기",
    export_pdf: "PDF로 내보내기",
    original_chat: "원래 대화",
    undo: "실행 취소",
    failed: "서랍을 불러오지 못함",
    loading: "아티팩트를 불러오는 중",
    not_yet: "준비 중",
};

static EN: Words = Words {
    saved: "Saved",
    editing: "Butler is editing",
    edited: "Butler edited this",
    restore: "Restore",
    versions: "Versions",
    current: "Current",
    me: "Me",
    butler: "Butler",
    export: "Export",
    markdown: "Markdown",
    pdf: "PDF",
    more_actions: "More actions",
    export_markdown: "Export as Markdown",
    export_pdf: "Export as PDF",
    original_chat: "Original chat",
    undo: "Undo",
    failed: "Could not load the library",
    loading: "Loading artifact",
    not_yet: "Coming soon",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
