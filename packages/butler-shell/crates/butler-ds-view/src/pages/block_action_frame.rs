//! BlockActionFrame.showcase.tsx: a block with a menu, a container with child blocks, and the
//! save flight. The flight (a block flying to its target) is not reproduced: Save only runs the
//! action.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::block_action_frame::{BlockActionFrame, Level};
use butler_ds::ui::blocks::block_columns::BlockColumns;
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::metric_card::{MetricCard, Trend};
use butler_ds::ui::blocks::overflow_action_menu::OverflowItem;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Inline, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    save: &'static str,
    doc: &'static str,
    copy: &'static str,
    menu: &'static str,
    spend: &'static str,
    plan: &'static str,
    family: &'static str,
    seats: &'static str,
    seats_value: &'static str,
    overview: &'static str,
    library: &'static str,
    save_now: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            save: "Save to library",
            doc: "Make a document",
            copy: "Copy",
            menu: "Block actions",
            spend: "Spending",
            plan: "Plan",
            family: "Family",
            seats: "Seats",
            seats_value: "4 of 6",
            overview: "This month",
            library: "Library",
            save_now: "Save",
        },
        Copy {
            save: "서랍에 저장",
            doc: "문서로 만들기",
            copy: "복사",
            menu: "블록 메뉴",
            spend: "지출",
            plan: "요금제",
            family: "가족",
            seats: "좌석",
            seats_value: "6개 중 4개",
            overview: "이번 달",
            library: "서랍",
            save_now: "저장",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Block with a menu",
            render: with_menu,
        },
        Story {
            name: "Container and children",
            render: container,
        },
        Story {
            name: "Save flight",
            render: save_flight,
        },
    ]
}

fn actions(frame: BlockActionFrame, c: &Copy) -> BlockActionFrame {
    frame
        .actions_label(c.menu)
        .action(OverflowItem::new(c.save).icon(Icon::Library))
        .action(OverflowItem::new(c.doc).icon(Icon::FileText))
        .action(OverflowItem::new(c.copy).icon(Icon::Copy))
}

fn with_menu(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    actions(BlockActionFrame::new("baf-menu").title(c.spend), &c)
        .child(MetricCard::text("baf-metric", "₩1,240,000", c.spend))
        .into_any_element()
}

fn container(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let spend = actions(
        BlockActionFrame::new("baf-spend")
            .level(Level::Child)
            .title(c.spend),
        &c,
    )
    .child(
        MetricCard::text("baf-card", "₩1,240,000", c.spend)
            .change("+8%")
            .trend(Trend::Down),
    );
    let plan = actions(BlockActionFrame::new("baf-plan").level(Level::Child), &c).child(
        Stack::new()
            .gap(Space::Xs)
            .child(KeyValueRow::new(c.plan, c.family))
            .child(KeyValueRow::new(c.seats, c.seats_value)),
    );
    actions(BlockActionFrame::new("baf-container").title(c.overview), &c)
        .child(BlockColumns::new("baf-columns").child(spend).child(plan))
        .into_any_element()
}

fn save_flight(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let library = icon(Icon::Library, IconSize::Sm, Ds::get(cx));
    let block = actions(BlockActionFrame::new("baf-flight").title(c.spend), &c).child(
        MetricCard::text("baf-flight-card", "₩1,240,000", c.spend)
            .change("+8%")
            .trend(Trend::Down),
    );
    Stack::new()
        .gap(Space::Lg)
        .child(
            Inline::new().child(
                Button::new("baf-library")
                    .variant(Variant::Ghost)
                    .size(Size::Sm)
                    .icon_start(library)
                    .text(c.library),
            ),
        )
        .child(block)
        .child(
            Inline::new().child(
                Button::new("baf-save")
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(c.save_now),
            ),
        )
        .into_any_element()
}
