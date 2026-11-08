//! SettingsActionField.showcase.tsx: an action with facts in meta, a facts card in details above
//! the action, progress under a busy button, two actions on one subject, and action rows in a
//! FormSection card.
use butler_ds::ui::blocks::form_section::FormSection;
use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::surface_panel::{Elevation, SurfacePanel};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::meta_list::{MetaItem, MetaList};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    section: &'static str,
    storage: &'static str,
    storage_description: &'static str,
    free: &'static str,
    reset: &'static str,
    reset_description: &'static str,
    reset_action: &'static str,
    chats: &'static str,
    size: &'static str,
    can_free: &'static str,
    freeing: &'static str,
    cancel: &'static str,
    history: &'static str,
    history_description: &'static str,
    view: &'static str,
    clear: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            section: "Chat memory",
            storage: "Storage",
            storage_description: "Deletes old memory files Butler no longer uses. What it remembers stays.",
            free: "Free up space",
            reset: "Reset chat memory",
            reset_description: "Erases everything remembered from chats. This can't be undone.",
            reset_action: "Reset",
            chats: "Chats",
            size: "Size",
            can_free: "Can free",
            freeing: "Freeing up space · 312.0 MB freed",
            cancel: "Cancel",
            history: "Visited pages",
            history_description: "View or clear the pages opened in Butler's browser.",
            view: "View",
            clear: "Clear",
        },
        Copy {
            section: "대화 기억",
            storage: "저장 공간",
            storage_description: "쓰지 않는 이전 기억 파일을 지웁니다. 기억한 내용은 그대로입니다.",
            free: "공간 정리",
            reset: "대화 기억 초기화",
            reset_description: "대화에서 기억한 내용을 모두 지웁니다. 되돌릴 수 없습니다.",
            reset_action: "초기화",
            chats: "대화",
            size: "크기",
            can_free: "확보 가능",
            freeing: "공간 정리 중 · 312.0 MB 확보",
            cancel: "취소",
            history: "방문한 페이지",
            history_description: "버틀러 브라우저에서 연 페이지 기록을 보거나 지웁니다.",
            view: "보기",
            clear: "지우기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Action with facts in meta",
            render: in_meta,
        },
        Story {
            name: "Facts card in details, above the action",
            render: in_details,
        },
        Story {
            name: "Progress under the button",
            render: busy,
        },
        Story {
            name: "Two actions on one subject",
            render: two_actions,
        },
        Story {
            name: "Action rows in a section card",
            render: rows,
        },
    ]
}

fn outline(id: &'static str, text: &'static str) -> Button {
    Button::new(id)
        .variant(Variant::Outline)
        .size(Size::Sm)
        .text(text)
}

fn facts(c: &Copy) -> MetaList {
    MetaList::new([
        MetaItem::new(c.chats, "128"),
        MetaItem::new(c.size, "1.2 GB"),
    ])
}

fn free_field(c: &Copy, id: &'static str) -> SettingsActionField {
    SettingsActionField::new(c.storage, c.storage_description, outline(id, c.free))
}

fn in_meta(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    free_field(&c, "action-free")
        .meta(facts(&c))
        .into_any_element()
}

fn in_details(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let card = SurfacePanel::new()
        .elevation(Elevation::Subtle)
        .child(MetaList::new([
            MetaItem::new(c.chats, "128"),
            MetaItem::new(c.size, "1.2 GB"),
            MetaItem::new(c.can_free, "312.0 MB"),
        ]));
    free_field(&c, "action-details")
        .details(card)
        .into_any_element()
}

fn busy(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let progress = button::container(Size::Sm)
        .child(Typo::caption(c.freeing).tone(Tone::Secondary))
        .child(outline("action-cancel", c.cancel));
    SettingsActionField::new(
        c.storage,
        c.storage_description,
        outline("action-busy", c.free).disabled(),
    )
    .after_control(progress)
    .into_any_element()
}

fn two_actions(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let actions = button::container(Size::Sm)
        .child(outline("action-view", c.view))
        .child(outline("action-clear", c.clear));
    SettingsActionField::new(c.history, c.history_description, actions).into_any_element()
}

fn rows(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FormSection::new(c.section)
        .holds_field()
        .child(free_field(&c, "card-free").meta(facts(&c)))
        .child(SettingsActionField::new(
            c.reset,
            c.reset_description,
            outline("card-reset", c.reset_action),
        ))
        .into_any_element()
}
