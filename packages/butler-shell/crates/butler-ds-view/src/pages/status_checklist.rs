//! StatusChecklist.showcase.tsx: an answer checklist.
use butler_ds::ui::blocks::status_checklist::{ChecklistItem, StatusChecklist};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Answer checklist",
        render: answer,
    }]
}

fn answer(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let items = lang.pick(
        [
            "Book the venue",
            "Send invitations",
            "Order the cake",
            "Confirm the photographer for the afternoon session and send the shot list",
        ],
        [
            "장소 예약",
            "초대장 보내기",
            "케이크 주문",
            "오후 촬영 작가 확정하고 촬영 목록 보내기",
        ],
    );
    StatusChecklist::new(
        items
            .into_iter()
            .enumerate()
            .map(|(index, text)| ChecklistItem::new(text, index < 2)),
    )
    .into_any_element()
}
