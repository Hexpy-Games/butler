//! The copy of the artifact viewer (`artifacts/ArtifactViewer`, `ArtifactBody`). Each field
//! names its `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct ArtifactViewerCopy {
    /// artifacts.revision
    pub(crate) revision: &'static str,
    /// artifacts.loading
    pub(crate) loading: &'static str,
    /// artifacts.unsupported
    pub(crate) unsupported: &'static str,
    /// artifacts.loadFailed
    pub(crate) load_failed: &'static str,
}

const KO: ArtifactViewerCopy = ArtifactViewerCopy {
    revision: "버전",
    loading: "아티팩트를 불러오는 중",
    unsupported: "앱 안에서 미리 볼 수 없는 아티팩트입니다",
    load_failed: "아티팩트를 불러오지 못했습니다",
};

const EN: ArtifactViewerCopy = ArtifactViewerCopy {
    revision: "Version",
    loading: "Loading artifact",
    unsupported: "This artifact cannot be previewed in the app",
    load_failed: "Could not load artifact",
};

impl ArtifactViewerCopy {
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }
}
