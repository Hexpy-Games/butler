//! showcase/support/AttachedComposer.tsx: the product composer with an adjunct panel attached
//! above it, the host of the "Attached to the composer" stories.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_card::{
    ComposerCard, PlanToggle, SendButton, Toolbar, ToolbarSpacer, textarea,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use gpui::{AnyElement, App, IntoElement, ParentElement as _, Window};

use super::sub;
use crate::copy::Lang;

/// `adjunct` over a card holding a two-row draft and the plan toggle.
pub(super) fn attached(
    lang: Lang,
    id: &'static str,
    adjunct: impl IntoElement,
    _: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (draft, more, plan) = lang.pick(
        (
            "Also check the settings pages at 375px.",
            "More options",
            "Plan",
        ),
        (
            "375px에서 설정 페이지도 확인해 주세요.",
            "추가 기능",
            "계획",
        ),
    );
    let ds = Ds::get(cx);
    ComposerCard::new(id)
        .large()
        .adjunct(adjunct)
        .child(textarea(sub(id, "draft")).default_value(draft).rows(2))
        .child(
            Toolbar::new()
                .child(IconButton::new(sub(id, "more"), more).icon(icon(
                    Icon::Plus,
                    IconSize::Md,
                    ds,
                )))
                .child(PlanToggle::new(sub(id, "plan"), true, plan))
                .child(ToolbarSpacer)
                .child(SendButton::new(sub(id, "send"))),
        )
        .into_any_element()
}
