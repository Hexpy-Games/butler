//! Label.showcase.tsx. Switch and Input arrive in B2/B3; the stand-ins draw only what the
//! labels sit above.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::context::Ds;
use butler_ds::ui::label::Label;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::copy::Lang;
use crate::standins::input_placeholder;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Above a switch (stacked switch field)",
            render: |lang, _, cx| {
                switch_field(lang.pick("Developer mode", "개발자 모드"), true, false, cx)
            },
        },
        Story {
            name: "Inside Field (FieldLabel)",
            render: engine,
        },
        Story {
            name: "Disabled control",
            render: |lang, _, cx| {
                switch_field(lang.pick("Search the web", "웹 검색 사용"), false, true, cx)
            },
        },
    ]
}

/// A Switch stand-in (track only, 32 x 18): the control the label names.
fn switch(on: bool, disabled: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let track = ds.color(if on {
        Color::Primary
    } else {
        Color::SwitchTrackBg
    });
    div()
        .w(px(32.))
        .h(px(18.))
        .rounded(ds.len(Length::RadiusPill))
        .bg(track)
        .opacity(if disabled { 0.5 } else { 1. }) // DS: Switch.module.css disabled tone
        .into_any_element()
}

fn switch_field(label: &'static str, on: bool, disabled: bool, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(Label::new().child(label))
        .child(switch(on, disabled, cx))
        .into_any_element()
}

fn engine(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(Label::new().child(lang.pick("Search engine", "검색 엔진")))
        .child(input_placeholder("DuckDuckGo", cx))
        .into_any_element()
}
