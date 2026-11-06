//! ListRow.showcase.tsx: title, description and meta; a long meta in a narrow row; a row next to
//! its own actions; a row inside a Clickable.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::clickable::Clickable;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, WithItem as _};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    model: &'static str,
    model_ref: &'static str,
    model_meta: &'static str,
    automation: &'static str,
    target: &'static str,
    every: &'static str,
    state: &'static str,
    artifact: &'static str,
    edit: &'static str,
    remove: &'static str,
    schedule: &'static str,
    schedule_meta: &'static str,
    long_title: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            model: "Local Coder 14B",
            model_ref: "local/coder:14b",
            model_meta: "32K tokens · medium reasoning",
            automation: "Nightly release notes",
            target: "butler · main",
            every: "Every day 07:00",
            state: "active / Every day 07:00",
            artifact: "A long artifact name that truncates when the inspector is narrow.md",
            edit: "Edit",
            remove: "Remove",
            schedule: "Daily eight",
            schedule_meta: "Active · Every day 08:00 · Next Tue 08:00 · Ask before acting",
            long_title: "Weekly dependency audit for every workspace repository",
        },
        Copy {
            model: "Local Coder 14B",
            model_ref: "local/coder:14b",
            model_meta: "32K 토큰 · 보통 추론",
            automation: "야간 릴리스 노트",
            target: "butler · main",
            every: "매일 07:00",
            state: "활성 / 매일 07:00",
            artifact: "인스펙터가 좁을 때 말줄임되는 아주 긴 산출물 이름.md",
            edit: "편집",
            remove: "삭제",
            schedule: "매일 여덟 시",
            schedule_meta: "활성 · 매일 08:00 · 다음 실행 화 08:00 · 실행 전 확인",
            long_title: "모든 작업 공간 저장소의 주간 의존성 점검",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Title, description and meta",
            render: basic,
        },
        Story {
            name: "Long meta in a narrow row",
            render: long_meta,
        },
        Story {
            name: "With trailing actions (local model)",
            render: with_actions,
        },
        Story {
            name: "Inside a Clickable (selectable list)",
            render: in_clickable,
        },
    ]
}

fn basic(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    Stack::new()
        .gap(Space::Sm)
        .child(
            ListRow::new(c.automation)
                .icon(icon(Icon::Clock3, IconSize::Md, ds))
                .meta(c.every),
        )
        .child(
            ListRow::new(c.automation)
                .description(c.target)
                .meta(c.state),
        )
        .child(ListRow::new(c.artifact).icon(icon(Icon::FileText, IconSize::Md, ds)))
        .into_any_element()
}

fn long_meta(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let clock = || icon(Icon::Clock3, IconSize::Md, ds);
    Stack::new()
        .gap(Space::Sm)
        .child(
            ListRow::new(c.schedule)
                .icon(clock())
                .description(c.target)
                .meta(c.schedule_meta),
        )
        .child(
            ListRow::new(c.long_title)
                .icon(clock())
                .description(c.target)
                .meta(c.schedule_meta),
        )
        .child(ListRow::new(c.long_title).icon(clock()).meta(c.every))
        .into_any_element()
}

fn with_actions(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let actions = butler_ds::ui::button::container(Size::IconSm)
        .child(
            Button::new("lr-edit")
                .size(Size::Sm)
                .variant(Variant::Borderless)
                .text(c.edit),
        )
        .child(
            Button::new("lr-remove")
                .size(Size::Sm)
                .variant(Variant::Borderless)
                .text(c.remove),
        );
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(
            Stack::new().grow().min_width(MinWidth::Zero).child(
                ListRow::new(c.model)
                    .description(c.model_ref)
                    .meta(c.model_meta),
            ),
        )
        .child(actions)
        .into_any_element()
}

fn in_clickable(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Clickable::new("lr-clickable")
        .stretch()
        .on_click(|_, _, _| {})
        .child(
            ListRow::new(c.automation)
                .description(c.target)
                .meta(c.state),
        )
        .into_any_element()
}
