//! The copy of the generated images and the editor. Each field names its
//! `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// conversation.answerBlocks.image
    pub(super) image: &'static str,
    /// conversation.imageTools.edit
    pub(super) edit: &'static str,
    /// conversation.imageTools.download
    pub(super) download: &'static str,
    /// conversation.imageTools.editor
    pub(super) editor: &'static str,
    /// conversation.imageTools.brush
    pub(super) brush: &'static str,
    /// conversation.imageTools.eraser
    pub(super) eraser: &'static str,
    /// conversation.imageTools.brushSize
    pub(super) brush_size: &'static str,
    /// conversation.imageTools.undo
    pub(super) undo: &'static str,
    /// conversation.imageTools.original
    pub(super) original: &'static str,
    /// conversation.imageTools.compare
    pub(super) compare: &'static str,
    /// conversation.imageTools.instruction
    pub(super) instruction: &'static str,
    /// conversation.imageTools.send
    pub(super) send: &'static str,
    /// conversation.imageTools.readOnly
    pub(super) read_only: &'static str,
    /// conversation.imageTools.noModel
    pub(super) no_model: &'static str,
    /// conversation.imageTools.failed
    pub(super) failed: &'static str,
    /// conversation.answerBlocks.saveToLibrary
    pub(super) save_to_library: &'static str,
    /// conversation.answerBlocks.savedToLibrary
    pub(super) saved_to_library: &'static str,
    /// conversation.answerBlocks.actionFailed
    pub(super) action_failed: &'static str,
    /// common.close
    pub(super) close: &'static str,
}

static KO: Words = Words {
    image: "이미지",
    edit: "편집",
    download: "다운로드",
    editor: "이미지 편집",
    brush: "브러시",
    eraser: "지우개",
    brush_size: "브러시 크기",
    undo: "실행 취소",
    original: "원본",
    compare: "길게 눌러 비교",
    instruction: "무엇을 바꿀까요?",
    send: "보내기",
    read_only: "읽기 전용",
    no_model: "이미지 모델 없음",
    failed: "편집하지 못했어요",
    save_to_library: "서랍에 저장",
    saved_to_library: "서랍에 저장했어요",
    action_failed: "실행하지 못했어요",
    close: "닫기",
};

static EN: Words = Words {
    image: "Image",
    edit: "Edit",
    download: "Download",
    editor: "Image editor",
    brush: "Brush",
    eraser: "Eraser",
    brush_size: "Brush size",
    undo: "Undo",
    original: "Original",
    compare: "Hold to compare",
    instruction: "What should change?",
    send: "Send",
    read_only: "Read-only",
    no_model: "No image model",
    failed: "Couldn't edit",
    save_to_library: "Save to library",
    saved_to_library: "Saved to library",
    action_failed: "Action failed",
    close: "Close",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
