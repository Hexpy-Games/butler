//! NativeSelect.showcase.tsx. The popup menu is the OS's (`Window::popup_menu`), which a
//! headless window does not have: these show the trigger and its keyboard focus, and a click
//! opens the DS list the control falls back to.
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    transport: &'static str,
    literal: &'static str,
    env: &'static str,
    keychain: &'static str,
    all: &'static str,
    turn: &'static str,
    turn_error: &'static str,
    local: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            transport: "Transport",
            literal: "Literal value",
            env: "Environment variable",
            keychain: "Keychain",
            all: "All kinds",
            turn: "Model turns",
            turn_error: "Model turn errors",
            local: "Local",
        },
        Copy {
            transport: "연결 방식",
            literal: "직접 입력",
            env: "환경 변수",
            keychain: "키체인",
            all: "모든 종류",
            turn: "모델 턴",
            turn_error: "모델 턴 오류",
            local: "로컬",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Secret value source",
            render: |lang, _, _| source("native-source", lang, Size::Default, false),
        },
        Story {
            name: "Sizes (default, sm)",
            render: sizes,
        },
        Story {
            name: "In a form field",
            render: in_field,
        },
        Story {
            name: "Grouped options, stretched",
            render: grouped,
        },
        Story {
            name: "Disabled",
            render: |lang, _, _| source("native-source-off", lang, Size::Default, true),
        },
    ]
}

fn source(id: &'static str, lang: Lang, size: Size, disabled: bool) -> AnyElement {
    let c = copy(lang);
    let select = NativeSelect::new(id)
        .probe(id)
        .size(size)
        .default_value("env")
        .option("literal", c.literal)
        .option("env", c.env)
        .option("keychain", c.keychain);
    if disabled {
        select.disabled().into_any_element()
    } else {
        select.into_any_element()
    }
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .wrap(true)
        .child(source("native-source-md", lang, Size::Default, false))
        .child(source("native-source-sm", lang, Size::Sm, false))
        .into_any_element()
}

fn in_field(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Field::new("native-field")
        .child(FieldLabel::new().child(c.transport))
        .child(
            NativeSelect::new("native-transport")
                .default_value("http")
                .option("stdio", "stdio")
                .option("http", "HTTP")
                .option("sse", "SSE"),
        )
        .into_any_element()
}

fn grouped(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    NativeSelect::new("native-kind")
        .stretch()
        .default_value("model_turn")
        .option("all", c.all)
        .group(
            c.local,
            [("model_turn", c.turn), ("model_turn_error", c.turn_error)],
        )
        .into_any_element()
}
