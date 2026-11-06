//! Label.showcase.tsx. Input arrives in B3; its stand-in draws only what the label sits above.
use butler_ds::ui::label::Label;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::switch::Switch;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins::input_placeholder;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Above a switch (stacked switch field)",
            render: |lang, _, _| {
                let label = lang.pick("Developer mode", "개발자 모드");
                switch_field("label-developer-mode", label, true, false)
            },
        },
        Story {
            name: "Inside Field (FieldLabel)",
            render: engine,
        },
        Story {
            name: "Disabled control",
            render: |lang, _, _| {
                let label = lang.pick("Search the web", "웹 검색 사용");
                switch_field("label-search", label, false, true)
            },
        },
    ]
}

fn switch_field(id: &'static str, label: &'static str, on: bool, disabled: bool) -> AnyElement {
    let mut switch = Switch::new(id).default_checked(on);
    if disabled {
        switch = switch.disabled();
    }
    Stack::new()
        .gap(Space::Sm)
        .child(Label::new().child(label))
        .child(switch)
        .into_any_element()
}

fn engine(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(Label::new().child(lang.pick("Search engine", "검색 엔진")))
        .child(input_placeholder("DuckDuckGo", cx))
        .into_any_element()
}
