//! ContextDonutButton.showcase.tsx: the usage levels, and the open and disabled states.
use butler_ds::ui::blocks::context_donut_button::ContextDonutButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

fn sample(id: &'static str, ratio: f32, caption: String, open: bool, disabled: bool) -> AnyElement {
    let mut button = ContextDonutButton::new(id, ratio).expanded(open);
    if disabled {
        button = button.disabled();
    }
    Stack::new()
        .gap(Space::Xs)
        .cross(Cross::Center)
        .child(button)
        .child(Typo::caption(caption))
        .into_any_element()
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Usage levels",
            render: levels,
        },
        Story {
            name: "States",
            render: states,
        },
    ]
}

fn levels(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let ids = ["cdb-8", "cdb-35", "cdb-64", "cdb-92", "cdb-100"];
    let samples = [0.08, 0.35, 0.64, 0.92, 1.]
        .into_iter()
        .zip(ids)
        .map(|(ratio, id)| {
            let percent = (ratio * 100_f32).round();
            let caption = lang.pick(format!("{percent}% used"), format!("{percent}% 사용"));
            sample(id, ratio, caption, false, false)
        });
    Stack::row()
        .gap(Space::Xl)
        .wrap(true)
        .children(samples)
        .into_any_element()
}

fn states(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (open, disabled) = lang.pick(
        ("Open (details shown)", "Disabled"),
        ("열림 (상세 표시 중)", "비활성"),
    );
    Stack::row()
        .gap(Space::Xl)
        .wrap(true)
        .child(sample("cdb-open", 0.64, open.to_owned(), true, false))
        .child(sample(
            "cdb-disabled",
            0.64,
            disabled.to_owned(),
            false,
            true,
        ))
        .into_any_element()
}
