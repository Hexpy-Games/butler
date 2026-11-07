//! Breadcrumb.showcase.tsx: the model-settings trail (back button and in-app steps), an
//! automation detail trail and a collapsed path with a link and an ellipsis. The state matrix
//! (default, hover, focus-visible, active) is covered by the live harness.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::breadcrumb::{
    Breadcrumb, BreadcrumbButton, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink,
    BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    back: &'static str,
    models: &'static str,
    management: &'static str,
    add: &'static str,
    automations: &'static str,
    nightly: &'static str,
    docs: &'static str,
    trail: &'static str,
    more: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            back: "Back",
            models: "Models",
            management: "Model management",
            add: "Add model",
            automations: "Schedules",
            nightly: "Nightly release notes",
            docs: "Docs",
            trail: "Location",
            more: "More",
        },
        Copy {
            back: "뒤로",
            models: "모델",
            management: "모델 관리",
            add: "모델 추가",
            automations: "예약 작업",
            nightly: "야간 릴리스 노트",
            docs: "문서",
            trail: "현재 위치",
            more: "더보기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Model settings trail",
            render: model_settings,
        },
        Story {
            name: "Automation detail",
            render: automation,
        },
        Story {
            name: "Collapsed path with link",
            render: collapsed,
        },
    ]
}

/// Model settings title: a back button and in-app steps (`ModelSettingsTrail`).
fn model_settings(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .child(IconButton::new("bc-back", c.back).glyph(Icon::ArrowLeft))
        .child(
            Breadcrumb::new(c.trail).child(
                BreadcrumbList::new()
                    .child(
                        BreadcrumbItem::new()
                            .child(BreadcrumbButton::new("bc-models").child(c.models)),
                    )
                    .child(BreadcrumbSeparator::new())
                    .child(
                        BreadcrumbItem::new()
                            .child(BreadcrumbButton::new("bc-management").child(c.management)),
                    )
                    .child(BreadcrumbSeparator::new())
                    .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(c.add))),
            ),
        )
        .into_any_element()
}

fn automation(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Breadcrumb::new(c.trail)
        .child(
            BreadcrumbList::new()
                .child(
                    BreadcrumbItem::new()
                        .child(BreadcrumbButton::new("bc-automations").child(c.automations)),
                )
                .child(BreadcrumbSeparator::new())
                .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(c.nightly))),
        )
        .into_any_element()
}

fn collapsed(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Breadcrumb::new(c.trail)
        .child(
            BreadcrumbList::new()
                .child(BreadcrumbItem::new().child(BreadcrumbLink::new("bc-docs").child(c.docs)))
                .child(BreadcrumbSeparator::new())
                .child(BreadcrumbItem::new().child(BreadcrumbEllipsis::new(c.more)))
                .child(BreadcrumbSeparator::new())
                .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(c.add))),
        )
        .into_any_element()
}
