//! PanelHeader.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::panel_header::PanelHeader;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    artifact: &'static str,
    artifact_meta: &'static str,
    back: &'static str,
    context: &'static str,
    context_meta: &'static str,
    add: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            artifact: "release-notes.md",
            artifact_meta: "Markdown · 4.2 KB · updated 3 minutes ago",
            back: "All artifacts",
            context: "Context usage",
            context_meta: "What fills the model's context window",
            add: "Add",
        },
        Copy {
            artifact: "release-notes.md",
            artifact_meta: "마크다운 · 4.2 KB · 3분 전 수정",
            back: "모든 산출물",
            context: "컨텍스트 사용량",
            context_meta: "모델 컨텍스트 창을 채우는 항목",
            add: "추가",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Artifact viewer header",
            render: artifact,
        },
        Story {
            name: "Title and description",
            render: title_description,
        },
        Story {
            name: "Title only",
            render: title_only,
        },
    ]
}

fn artifact(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    PanelHeader::new(c.artifact)
        .description(c.artifact_meta)
        .actions(
            Button::new("panel-header-back")
                .variant(Variant::Borderless)
                .size(Size::Xs)
                .icon_start(icon(Icon::ArrowLeft, IconSize::Sm, ds))
                .text(c.back),
        )
        .into_any_element()
}

fn title_description(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    PanelHeader::new(c.context)
        .description(c.context_meta)
        .actions(
            Button::new("panel-header-add")
                .variant(Variant::Outline)
                .size(Size::Sm)
                .icon_start(icon(Icon::Plus, IconSize::Md, ds))
                .text(c.add),
        )
        .into_any_element()
}

fn title_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    PanelHeader::new(copy(lang).context).into_any_element()
}
