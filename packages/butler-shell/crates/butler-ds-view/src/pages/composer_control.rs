//! ComposerControl.showcase.tsx: the pill controls of the composer toolbar. Each fixture is a
//! `composer` container, so a narrow canvas takes the narrow rules (icon-only circles, no detail).
//! The Select trigger story uses ComposerControl as the Select's own control.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_control::{
    Compact, ComposerControl, ControlTone, PermissionTone,
};
use butler_ds::ui::blocks::measure;
use butler_ds::ui::blocks::scope::{ComposerVars, Spec, scoped};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::overlay::place::Side;
use butler_ds::ui::popover::{Popover, PopoverContent};
use butler_ds::ui::select::{Select, SelectContent, SelectItem};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::{Story, sub};
use crate::copy::Lang;

struct Copy {
    ask: &'static str,
    workspace: &'static str,
    reasoning: &'static str,
    medium: &'static str,
    access: &'static str,
    model_error: &'static str,
    local: &'static str,
    worktree: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            ask: "Ask",
            workspace: "workspace",
            reasoning: "Reasoning",
            medium: "medium",
            access: "Full access",
            model_error: "Model unavailable",
            local: "Local",
            worktree: "Worktree",
        },
        Copy {
            ask: "질문",
            workspace: "워크스페이스",
            reasoning: "추론",
            medium: "보통",
            access: "전체 권한",
            model_error: "모델을 쓸 수 없음",
            local: "로컬",
            worktree: "워크트리",
        },
    )
}

/// `.fixture`: a `composer` container (`@container composer (width <= 520px)`).
fn fixture(id: &'static str, child: AnyElement, window: &mut Window, cx: &mut App) -> AnyElement {
    let (size, recorder) = measure::track(sub(id, "fixture"), window, cx);
    let narrow = size.width > px(0.) && f32::from(size.width) <= 520.;
    div()
        .relative()
        .flex()
        .flex_col()
        .items_start()
        .child(recorder)
        .child(scoped(
            Spec {
                composer: Some(ComposerVars {
                    narrow,
                    padding: (0., 0.),
                    expanded: true,
                }),
                ..Spec::default()
            },
            child,
        ))
        .into_any_element()
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Controls",
            render: controls,
        },
        Story {
            name: "Error tone",
            render: error,
        },
        Story {
            name: "Permission tones",
            render: permission,
        },
        Story {
            name: "Icon-only access as a popover trigger",
            render: popover,
        },
        Story {
            name: "Select trigger (workspace chip)",
            render: select,
        },
    ]
}

fn controls(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let row = Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .child(
            ComposerControl::new("cc-ask", c.ask)
                .icon(icon(Icon::Search, IconSize::Md, ds))
                .detail(c.workspace)
                .active(true),
        )
        .child(
            ComposerControl::new("cc-reasoning", c.reasoning)
                .icon(icon(Icon::SlidersHorizontal, IconSize::Md, ds))
                .detail(c.medium),
        )
        .child(
            ComposerControl::new("cc-access", c.access)
                .icon(icon(Icon::ShieldCheck, IconSize::Md, ds))
                .compact(Compact::Icon),
        )
        .into_any_element();
    fixture("cc-controls", row, window, cx)
}

fn error(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let control = ComposerControl::new("cc-error", copy(lang).model_error)
        .icon(icon(Icon::AlertCircle, IconSize::Md, ds))
        .tone(ControlTone::Danger)
        .into_any_element();
    fixture("cc-error-fixture", control, window, cx)
}

fn permission(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let tone = |id: &'static str, tone: PermissionTone| {
        ComposerControl::new(id, c.access)
            .icon(icon(Icon::ShieldCheck, IconSize::Md, ds))
            .permission_tone(tone)
    };
    let row = Stack::row()
        .gap(Space::Sm)
        .wrap(true)
        .child(tone("cc-full", PermissionTone::Full))
        .child(tone("cc-ask-tone", PermissionTone::Ask))
        .child(tone("cc-read", PermissionTone::Read))
        .into_any_element();
    fixture("cc-permission", row, window, cx)
}

fn popover(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("cc-popover", window, cx);
    let ds = Ds::get(cx);
    let trigger = popover.trigger(|toggle| {
        ComposerControl::new("cc-popover-trigger", c.access)
            .icon(icon(Icon::ShieldCheck, IconSize::Md, ds))
            .permission_tone(PermissionTone::Full)
            .compact(Compact::Icon)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new().side(Side::Top).child(c.access),
        window,
        cx,
    );
    let body = Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element();
    fixture("cc-popover-fixture", body, window, cx)
}

fn select(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("cc-select", window, cx).default_value("local", cx);
    let content = SelectContent::new()
        .child(SelectItem::new("local", c.local))
        .child(SelectItem::new("worktree", c.worktree));
    let worktree = select.selected(cx).is_some_and(|value| value == "worktree");
    let ds = Ds::get(cx);
    let control = ComposerControl::new(
        "cc-select-trigger",
        if worktree { c.worktree } else { c.local },
    )
    .icon(icon(
        if worktree {
            Icon::GitBranch
        } else {
            Icon::Monitor
        },
        IconSize::Sm,
        ds,
    ));
    let trigger = select.control_trigger(control.into_any_element(), &content);
    let row = Stack::row()
        .gap(Space::Sm)
        .child(
            ComposerControl::new("cc-select-access", c.access).icon(icon(
                Icon::ShieldCheck,
                IconSize::Md,
                ds,
            )),
        )
        .child(trigger)
        .child(select.content(&content, window, cx))
        .into_any_element();
    fixture("cc-select-fixture", row, window, cx)
}
