//! The copy of the file viewer (`fileViewer` in `packages/butler-i18n/src/locales/file-viewer.ts`).
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct FileViewerStrings {
    /// fileViewer.title
    pub(crate) title: &'static str,
    /// fileViewer.files
    pub(crate) files: &'static str,
    /// fileViewer.close
    pub(crate) close: &'static str,
    /// fileViewer.closeFile
    pub(crate) close_file: &'static str,
    /// fileViewer.backToChat
    pub(crate) back_to_chat: &'static str,
}

const KO: FileViewerStrings = FileViewerStrings {
    title: "파일 보기",
    files: "파일",
    close: "닫기",
    close_file: "파일 닫기",
    back_to_chat: "대화로 돌아가기",
};

const EN: FileViewerStrings = FileViewerStrings {
    title: "View files",
    files: "Files",
    close: "Close",
    close_file: "Close file",
    back_to_chat: "Back to chat",
};

impl FileViewerStrings {
    /// The copy of the app language.
    pub(crate) fn get(cx: &App) -> &'static Self {
        match Ds::get(cx).lang() {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }
}
