//! The copy of the AdaptiveShell showcase (English and Korean).
use crate::copy::Lang;

pub(super) struct Copy {
    pub(super) navigation: &'static str,
    pub(super) workspace: &'static str,
    pub(super) inspector: &'static str,
    pub(super) close: &'static str,
    pub(super) open_nav: &'static str,
    pub(super) open_inspector: &'static str,
    pub(super) resize: &'static str,
    pub(super) drag: &'static str,
    pub(super) hint: &'static str,
    pub(super) peek_edge: &'static str,
    pub(super) native_pointer: &'static str,
    pub(super) peek_open: &'static str,
    pub(super) peek_closed: &'static str,
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            navigation: "Navigation",
            workspace: "Conversation",
            inspector: "Inspector",
            close: "Close",
            open_nav: "Open navigation",
            open_inspector: "Open inspector",
            resize: "Resize left sidebar",
            drag: "Drag to resize",
            hint: "Below 768px the side panels become drawers over a scrim; at app width they sit beside the workspace.",
            peek_edge: "Peek the sidebar",
            native_pointer: "Pointer moves onto the native page",
            peek_open: "Peek open",
            peek_closed: "Peek closed",
        },
        Copy {
            navigation: "내비게이션",
            workspace: "대화",
            inspector: "인스펙터",
            close: "닫기",
            open_nav: "내비게이션 열기",
            open_inspector: "인스펙터 열기",
            resize: "왼쪽 사이드바 크기 조절",
            drag: "드래그하여 크기 조절",
            hint: "768px 미만에서는 양쪽 패널이 스크림 위 드로어가 되고, 앱 너비에서는 작업 영역 옆에 놓입니다.",
            peek_edge: "사이드바 살짝 보기",
            native_pointer: "포인터가 네이티브 페이지로 이동",
            peek_open: "열림",
            peek_closed: "닫힘",
        },
    )
}
