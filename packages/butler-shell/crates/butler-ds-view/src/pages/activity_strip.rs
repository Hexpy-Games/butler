//! ActivityStrip.showcase.tsx: two weeks of changes under their count.
use butler_ds::ui::blocks::activity_strip::{ActivityStrip, ActivityStripDay};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

/// The active days of the fortnight.
const ACTIVE: [usize; 6] = [1, 2, 5, 9, 10, 13];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Two weeks of changes",
        render: fortnight,
    }]
}

/// September 13 + `index`, 2026, as "Sep 13" / "9월 13일" (the stories stay inside two months).
fn date(index: usize, lang: Lang) -> String {
    let (month, day) = if 13 + index <= 30 {
        (9, 13 + index)
    } else {
        (10, 13 + index - 30)
    };
    lang.pick(
        format!("{} {day}", MONTHS[month - 1]),
        format!("{month}월 {day}일"),
    )
}

fn fortnight(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let days: Vec<_> = (0..14)
        .map(|index| {
            ActivityStripDay::new(
                index.to_string(),
                date(index, lang),
                ACTIVE.contains(&index),
            )
        })
        .collect();
    let spoken = days
        .iter()
        .filter(|day| day.active)
        .map(|day| day.label.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let count = lang.pick("6 changes", "변경 6회");
    Stack::new()
        .gap(Space::Xs)
        .child(Typo::caption(count).tone(Tone::Secondary))
        .child(ActivityStrip::new("activity-strip", days, spoken))
        .into_any_element()
}
