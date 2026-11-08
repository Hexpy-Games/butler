//! SettingsHeader.showcase.tsx: the title and description every settings page opens with, and
//! a subpage's breadcrumb as the secondary line.
use butler_ds::ui::blocks::breadcrumb::{
    Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage,
    BreadcrumbSeparator,
};
use butler_ds::ui::blocks::settings_header::SettingsHeader;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    appearance: &'static str,
    appearance_hint: &'static str,
    models: &'static str,
    models_hint: &'static str,
    management: &'static str,
    add: &'static str,
    breadcrumb: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            appearance: "Appearance",
            appearance_hint: "Choose a theme and density that fits your workspace.",
            models: "Models",
            models_hint: "Connect providers and choose the default model.",
            management: "Manage models",
            add: "Add model",
            breadcrumb: "Breadcrumb",
        },
        Copy {
            appearance: "화면",
            appearance_hint: "작업 공간에 맞는 테마와 밀도를 고르세요.",
            models: "모델",
            models_hint: "제공자를 연결하고 기본 모델을 고르세요.",
            management: "모델 관리",
            add: "모델 추가",
            breadcrumb: "이동 경로",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Title and description (every settings page)",
            render: title_and_description,
        },
        Story {
            name: "Subpage breadcrumb as the secondary line",
            render: subpage,
        },
    ]
}

fn title_and_description(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SettingsHeader::new(c.appearance)
        .description(c.appearance_hint)
        .into_any_element()
}

fn subpage(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let trail = Breadcrumb::new(c.breadcrumb).child(
        BreadcrumbList::new()
            .child(BreadcrumbItem::new().child(BreadcrumbButton::new("sh-models").child(c.models)))
            .child(BreadcrumbSeparator::new())
            .child(
                BreadcrumbItem::new()
                    .child(BreadcrumbButton::new("sh-management").child(c.management)),
            )
            .child(BreadcrumbSeparator::new())
            .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(c.add))),
    );
    SettingsHeader::new(c.models)
        .description(c.models_hint)
        .secondary(trail)
        .into_any_element()
}
