//! CopyButton.showcase.tsx.
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Inline, Space};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    action: &'static str,
    copied: &'static str,
    code: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            action: "Copy message",
            copied: "Copied",
            code: "Copy code",
        },
        Copy {
            action: "메시지 복사",
            copied: "복사됨",
            code: "코드 복사",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Copy and confirm",
            render: confirm,
        },
        Story {
            name: "Copied state",
            render: copied,
        },
    ]
}

fn confirm(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .gap(Space::Sm)
        .child(
            CopyButton::new("copy-message", c.action, c.copied).text("Butler copied this message."),
        )
        .child(CopyButton::new("copy-code", c.code, c.copied).text("const ok = true;"))
        .into_any_element()
}

fn copied(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    CopyButton::new("copy-copied", c.action, c.copied)
        .copied(true)
        .on_copy(|_| {})
        .into_any_element()
}
