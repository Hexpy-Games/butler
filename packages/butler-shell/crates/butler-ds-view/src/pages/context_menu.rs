//! ContextMenu.showcase.tsx. MessageRow is a stand-in (`standins_overlay.rs`). The menus open
//! on a right click; the touch long-press is not ported (there is no touch input).
use butler_ds::ui::Icon;
use butler_ds::ui::context_menu::{ContextMenu, ContextMenuContent, Item, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins_overlay::message_row_system;

struct Copy {
    hint: &'static str,
    message: &'static str,
    clipboard: &'static str,
    branch: &'static str,
    remove: &'static str,
    unavailable: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            hint: "Right-click (or long-press) the message.",
            message: "Compacted 42 earlier turns into a summary to free context.",
            clipboard: "Copy",
            branch: "Branch from here",
            remove: "Delete",
            unavailable: "Delete (not allowed for system messages)",
        },
        Copy {
            hint: "메시지를 오른쪽 클릭하거나 길게 누르세요.",
            message: "컨텍스트를 확보하려고 이전 42개 턴을 요약했습니다.",
            clipboard: "복사",
            branch: "여기서 분기",
            remove: "삭제",
            unavailable: "삭제 (시스템 메시지는 삭제할 수 없음)",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Message copy menu",
            render: message,
        },
        Story {
            name: "Destructive and disabled items",
            render: items,
        },
    ]
}

/// VirtualMessageRow: system messages expose Copy through a context menu.
fn message(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let menu = ContextMenu::new("cm-message", window, cx);
    let trigger = menu.trigger(message_row_system(c.message, cx));
    let content = menu.content(
        ContextMenuContent::new().child(Item::new(c.clipboard).icon(Icon::Copy)),
        window,
        cx,
    );
    Stack::new()
        .child(
            Stack::new()
                .gap(Space::Sm)
                .child(trigger)
                .child(Typo::caption(c.hint).tone(Tone::Secondary)),
        )
        .child(content)
        .into_any_element()
}

fn items(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let menu = ContextMenu::new("cm-items", window, cx);
    let trigger = menu.trigger(Typo::body(c.hint));
    let content = menu.content(
        ContextMenuContent::new()
            .child(Item::new(c.clipboard).icon(Icon::Copy))
            .child(Item::new(c.branch).icon(Icon::GitBranch))
            .child(
                Item::new(c.remove)
                    .icon(Icon::Trash2)
                    .variant(Variant::Destructive),
            )
            .child(Item::new(c.unavailable).disabled()),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}
