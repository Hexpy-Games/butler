//! SortableCardList.showcase.tsx: the BackupModelsSettings list (drag a card by its grip, or move
//! it with the arrow keys on a focused grip; the card lifts and a line shows where it lands) and
//! the empty list.
use butler_ds::ui::blocks::sortable_card_list::{SortableCardItem, SortableCardList};
use butler_ds::ui::button::{Button, Size, Variant};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    title: &'static str,
    description: &'static str,
    show_empty: &'static str,
    show_cards: &'static str,
    empty: &'static str,
    /// Id, title, meta, description.
    models: [(&'static str, &'static str, &'static str, &'static str); 3],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "Backup models",
            description: "Drag with a pointer or the keyboard to change the order Butler tries them in.",
            show_empty: "Show empty",
            show_cards: "Show cards",
            empty: "Add a model to create a backup chain.",
            models: [
                ("claude", "Claude Sonnet", "Anthropic", "Balanced reasoning"),
                ("gemini", "Gemini Flash", "Google", "Fast multimodal model"),
                ("grok", "Grok", "xAI", "Long-context model"),
            ],
        },
        Copy {
            title: "예비 모델",
            description: "포인터나 키보드로 끌어 버틀러가 시도할 순서를 바꾸세요.",
            show_empty: "빈 상태 보기",
            show_cards: "카드 보기",
            empty: "모델을 추가해 예비 순서를 만드세요.",
            models: [
                ("claude", "Claude Sonnet", "Anthropic", "균형 잡힌 추론"),
                ("gemini", "Gemini Flash", "Google", "빠른 멀티모달 모델"),
                ("grok", "Grok", "xAI", "긴 컨텍스트 모델"),
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Reorder with lift",
            render: backup_models,
        },
        Story {
            name: "Empty",
            render: empty,
        },
    ]
}

/// BackupModelsSettings: a live list with a button that swaps it for the empty state.
fn backup_models(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let key = format!("scl-backup-{lang:?}");
    let items = window.use_keyed_state(key.clone(), cx, |_, _| {
        c.models
            .iter()
            .map(|&(id, title, meta, description)| {
                SortableCardItem::new(id, title)
                    .label(title)
                    .meta(meta)
                    .description(description)
            })
            .collect::<Vec<_>>()
    });
    let hidden = window.use_keyed_state(format!("{key}-empty"), cx, |_, _| false);
    let showing_empty = *hidden.read(cx);
    let shown = if showing_empty {
        Vec::new()
    } else {
        items.read(cx).clone()
    };
    let (reorder, remove) = (items.clone(), items);
    let toggle = Button::new("scl-toggle")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(if showing_empty {
            c.show_cards
        } else {
            c.show_empty
        })
        .on_click(move |_, _, cx| {
            hidden.update(cx, |hidden, cx| {
                *hidden = !*hidden;
                cx.notify();
            });
        });
    SortableCardList::new(key, shown)
        .title(c.title)
        .description(c.description)
        .empty_message(c.empty)
        .actions(toggle)
        .on_reorder(move |ids, _, cx| {
            reorder.update(cx, |items, cx| {
                items.sort_by_key(|item| ids.iter().position(|id| *id == item.id));
                cx.notify();
            });
        })
        .on_remove(move |id, _, cx| {
            remove.update(cx, |items, cx| {
                items.retain(|item| item.id != *id);
                cx.notify();
            });
        })
        .into_any_element()
}

fn empty(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SortableCardList::new("scl-empty", Vec::new())
        .title(c.title)
        .empty_message(c.empty)
        .into_any_element()
}
