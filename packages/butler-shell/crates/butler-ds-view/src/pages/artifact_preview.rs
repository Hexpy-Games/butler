//! ArtifactPreview.showcase.tsx: text, an image, frames, loading and failed, and the page
//! surface. Frames hold no page (web artifacts are the P5 browser's), and the three page-surface
//! stories, which React draws inside a scaled AdaptiveShell file viewer (ShellFrameDemo), show
//! the page-surface preview alone in a plain 405px-tall box.
use butler_ds::ui::blocks::artifact_preview::{
    ArtifactPreview, ArtifactPreviewFrame, ArtifactPreviewImage, ArtifactPreviewPre, Surface,
};
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use super::attachment_list::thumbnail_wide;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Text",
            render: text,
        },
        Story {
            name: "Image",
            render: image,
        },
        Story {
            name: "Frame (PDF, HTML)",
            render: frame,
        },
        Story {
            name: "Frame at its own size",
            render: own_size,
        },
        Story {
            name: "Loading and failed",
            render: states,
        },
        Story {
            name: "Page surface: markdown in a docked viewer",
            render: page_markdown,
        },
        Story {
            name: "Page surface: code file",
            render: page_code,
        },
        Story {
            name: "Page surface: image, frameless",
            render: page_image,
        },
    ]
}

struct Copy {
    text: &'static str,
    loading: &'static str,
    failed: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            text: "# Release notes\n\n- Token pages generated from tokens.css\n- States matrix on item pages\n- Motion page with replay",
            loading: "Loading the artifact…",
            failed: "Could not load this artifact.",
        },
        Copy {
            text: "# 릴리스 노트\n\n- tokens.css에서 만든 토큰 페이지\n- 항목 페이지의 상태 매트릭스\n- 다시 재생되는 모션 페이지",
            loading: "산출물을 불러오는 중…",
            failed: "이 산출물을 불러오지 못했습니다.",
        },
    )
}

fn text(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ArtifactPreview::new("ap-text")
        .child(ArtifactPreviewPre::new(copy(lang).text))
        .into_any_element()
}

fn image(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ArtifactPreview::new("ap-image")
        .child(ArtifactPreviewImage::new(thumbnail_wide(), (320., 180.)))
        .into_any_element()
}

fn frame(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ArtifactPreview::new("ap-frame")
        .child(ArtifactPreviewFrame::new())
        .into_any_element()
}

fn own_size(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ArtifactPreview::new("ap-own")
        .child(ArtifactPreviewFrame::new().intrinsic_size(240., 96.))
        .into_any_element()
}

fn states(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    div()
        .child(ArtifactPreview::new("ap-loading").child(Typo::caption(c.loading)))
        .child(ArtifactPreview::new("ap-failed").child(Typo::caption(c.failed)))
        .into_any_element()
}

fn page_box(content: impl gpui::IntoElement) -> AnyElement {
    div()
        .h(px(405.))
        .overflow_hidden()
        .px(px(48.))
        .py(px(24.))
        .child(content)
        .into_any_element()
}

fn page_markdown(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    page_box(
        ArtifactPreview::new("ap-page-md")
            .surface(Surface::Page)
            .child(MarkdownContent::new("ap-page-md-body", copy(lang).text)),
    )
}

fn page_code(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    page_box(
        ArtifactPreview::new("ap-page-code")
            .surface(Surface::Page)
            .child(ArtifactPreviewPre::new(copy(lang).text)),
    )
}

fn page_image(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    page_box(
        ArtifactPreview::new("ap-page-image")
            .surface(Surface::Page)
            .child(ArtifactPreviewImage::new(thumbnail_wide(), (320., 180.))),
    )
}
