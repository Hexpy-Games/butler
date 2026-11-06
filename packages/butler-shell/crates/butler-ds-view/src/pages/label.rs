//! Label.showcase.tsx.
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::label::Label;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

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
    Field::new(format!("{id}-field"))
        .child(Label::new().child(label))
        .child(switch)
        .into_any_element()
}

fn engine(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Field::new("label-engine-field")
        .child(FieldLabel::new().child(lang.pick("Search engine", "검색 엔진")))
        .child(Input::new("label-engine").default_value("DuckDuckGo"))
        .into_any_element()
}
