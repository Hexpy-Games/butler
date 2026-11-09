//! Section.showcase.tsx: an inspector section with a description, a section with an action, and
//! icon titles with an empty state.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::section::Section;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    artifacts: &'static str,
    automations: &'static str,
    plans: &'static str,
    specs: &'static str,
    add: &'static str,
    description: &'static str,
    view_all: &'static str,
    items: [&'static str; 2],
    nightly: &'static str,
    every: &'static str,
    empty: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            artifacts: "Artifacts",
            automations: "Schedules",
            plans: "Plans",
            specs: "Specs",
            add: "New schedule",
            description: "Files Butler created or changed in this conversation.",
            view_all: "View all",
            items: ["release-notes.md", "design-review.png"],
            nightly: "Nightly release notes",
            every: "Every day 07:00",
            empty: "No specs yet.",
        },
        Copy {
            artifacts: "산출물",
            automations: "예약 작업",
            plans: "계획",
            specs: "명세",
            add: "새 예약 작업",
            description: "이 대화에서 버틀러가 만들거나 바꾼 파일입니다.",
            view_all: "모두 보기",
            items: ["release-notes.md", "design-review.png"],
            nightly: "야간 릴리스 노트",
            every: "매일 07:00",
            empty: "아직 명세가 없습니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Inspector section",
            render: inspector,
        },
        Story {
            name: "With actions",
            render: actions,
        },
        Story {
            name: "Icon title, empty state",
            render: icons,
        },
    ]
}

fn glyph(glyph: Icon, cx: &App) -> AnyElement {
    icon(glyph, IconSize::Md, Ds::get(cx)).into_any_element()
}

fn inspector(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Section::new("section-inspector")
        .title(c.artifacts)
        .description(c.description)
        .gap(Space::Md)
        .children(
            c.items
                .map(|item| ListRow::new(item).icon(glyph(Icon::FileText, cx))),
        )
        .into_any_element()
}

fn actions(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Section::new("section-actions")
        .title(c.automations)
        .actions(IconButton::new("section-add", c.add).icon(glyph(Icon::Plus, cx)))
        .gap(Space::Sm)
        .child(
            ListRow::new(c.nightly)
                .icon(glyph(Icon::Clock3, cx))
                .meta(c.every),
        )
        .into_any_element()
}

fn icons(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Xxl)
        .child(
            Section::new("section-plans")
                .icon(glyph(Icon::ListChecks, cx))
                .title(c.plans)
                .actions(
                    Button::new("section-view-all")
                        .size(Size::Sm)
                        .variant(Variant::Borderless)
                        .text(c.view_all),
                )
                .gap(Space::Lg)
                .child(ListRow::new(c.nightly)),
        )
        .child(
            Section::new("section-specs")
                .icon(glyph(Icon::BookOpenText, cx))
                .title(c.specs)
                .gap(Space::Lg)
                .child(EmptyLine::new(c.empty)),
        )
        .into_any_element()
}
