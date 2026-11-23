//! The browser selection labels from the Electron locale.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;
pub(crate) struct Words {
    pub(crate) drag: &'static str,
    pub(crate) mode: &'static str,
    pub(crate) hint: &'static str,
    pub(crate) keys: &'static str,
    pub(crate) first: &'static str,
    pub(crate) attach: &'static str,
    pub(crate) scrap: &'static str,
    pub(crate) save: &'static str,
    pub(crate) copy: &'static str,
    pub(crate) clear: &'static str,
    pub(crate) remove: &'static str,
    pub(crate) finish: &'static str,
    pub(crate) selected: fn(usize) -> String,
    pub(crate) images_saved: fn(usize) -> String,
    pub(crate) copied: &'static str,
    pub(crate) failed: &'static str,
}
pub(crate) fn words(cx: &App) -> Words {
    let mac = butler_platform::launcher::node_platform() == "darwin";
    match Ds::get(cx).lang() {
        Lang::En => Words {
            drag: "Drag into the chat",
            mode: "Picking",
            hint: "Pick page elements",
            keys: if mac {
                "↑↓ Resize · ⌥ drag for area"
            } else {
                "↑↓ Resize · Alt drag for area"
            },
            first: "Pick an element first",
            attach: "Add to chat",
            scrap: "Scrap",
            save: "Save image",
            copy: "Copy text",
            clear: "Clear",
            remove: "Delete",
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
            keys: if mac {
                "↑↓ 범위 조절 · ⌥ 드래그로 영역"
            } else {
                "↑↓ 범위 조절 · Alt 드래그로 영역"
            },
            first: "먼저 요소를 선택하세요",
            attach: "대화에 첨부",
            scrap: "스크랩",
            save: "이미지 저장",
            copy: "텍스트 복사",
            clear: "지우기",
            remove: "삭제",
            finish: "끝내기",
            selected: |n| format!("{n}개 선택됨"),
            images_saved: |n| format!("{n}개 이미지 저장됨"),
            copied: "복사됨",
            failed: "페이지를 열지 못함",
        },
    }
}
