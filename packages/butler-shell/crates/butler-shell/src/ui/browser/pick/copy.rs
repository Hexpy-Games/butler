//! The browser selection labels from the Electron locale.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;
pub(super) struct Words {
    pub(super) drag: &'static str,
    pub(super) mode: &'static str,
    pub(super) hint: &'static str,
    pub(super) keys: &'static str,
    pub(super) first: &'static str,
    pub(super) attach: &'static str,
    pub(super) scrap: &'static str,
    pub(super) save: &'static str,
    pub(super) copy: &'static str,
    pub(super) clear: &'static str,
    pub(super) finish: &'static str,
    pub(super) selected: fn(usize) -> String,
    pub(super) images_saved: fn(usize) -> String,
    pub(super) copied: &'static str,
    pub(super) failed: &'static str,
}
pub(super) fn words(cx: &App) -> Words {
    match Ds::get(cx).lang() {
        Lang::En => Words {
            drag: "Drag into the chat",
            mode: "Picking",
            hint: "Pick page elements",
            keys: "↑↓ Resize · ⌥ drag for area",
            first: "Pick an element first",
            attach: "Add to chat",
            scrap: "Scrap",
            save: "Save image",
            copy: "Copy text",
            clear: "Clear",
            finish: "Done",
            selected: |n| format!("{n} selected"),
            images_saved: |n| format!("{n} images saved"),
            copied: "Copied",
            failed: "Could not open page",
        },
        Lang::Ko => Words {
            drag: "끌어서 대화에 놓기",
            mode: "요소 선택 중",
            hint: "페이지 요소 선택",
            keys: "↑↓ 범위 조절 · ⌥ 드래그로 영역",
            first: "먼저 요소를 선택하세요",
            attach: "대화에 첨부",
            scrap: "스크랩",
            save: "이미지 저장",
            copy: "텍스트 복사",
            clear: "지우기",
            finish: "끝내기",
            selected: |n| format!("{n}개 선택됨"),
            images_saved: |n| format!("{n}개 이미지 저장됨"),
            copied: "복사됨",
            failed: "페이지를 열지 못함",
        },
    }
}
