//! BlockColumns.showcase.tsx: two and three columns of answer blocks.
use butler_ds::ui::blocks::block_columns::BlockColumns;
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::metric_card::{MetricCard, Trend};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Two columns",
            render: two,
        },
        Story {
            name: "Three columns",
            render: three,
        },
    ]
}

fn two(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (spend, income) = lang.pick(("Spending", "Income"), ("지출", "수입"));
    BlockColumns::new("bc-two")
        .child(
            MetricCard::text("bc-spend", "₩1,240,000", spend)
                .change("+8%")
                .trend(Trend::Down),
        )
        .child(
            MetricCard::text("bc-income", "₩3,100,000", income)
                .change("+2%")
                .trend(Trend::Up),
        )
        .into_any_element()
}

fn three(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (spend, note, plan, plan_value, seats, seats_value) = lang.pick(
        (
            "Spending",
            "Rent is due on the 25th.",
            "Plan",
            "Family",
            "Seats",
            "4 of 6",
        ),
        (
            "지출",
            "월세는 25일에 나가요.",
            "요금제",
            "가족",
            "좌석",
            "6개 중 4개",
        ),
    );
    BlockColumns::new("bc-three")
        .child(MetricCard::text("bc3-spend", "₩1,240,000", spend))
        .child(
            Stack::new()
                .gap(Space::Xs)
                .child(KeyValueRow::new(plan, plan_value))
                .child(KeyValueRow::new(seats, seats_value)),
        )
        .child(Notice::new(NoticeTone::Info, note))
        .into_any_element()
}
