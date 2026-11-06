//! The copy of the NavDropTarget showcase, in English and Korean.
use crate::copy::Lang;

pub(super) struct Copy {
    pub(super) rows: [&'static str; 5],
    pub(super) group: &'static str,
    pub(super) root: &'static str,
    pub(super) step: &'static str,
    pub(super) grouped: &'static str,
    pub(super) schedules: &'static str,
    pub(super) library: &'static str,
    pub(super) chats: [&'static str; 4],
    pub(super) attach: &'static str,
    pub(super) save: &'static str,
    pub(super) invalid: &'static str,
    pub(super) more: [&'static str; 6],
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            rows: [
                "Desktop client polish",
                "Weekly review",
                "Travel plan",
                "Reading list",
                "Release notes",
            ],
            group: "Group together",
            root: "Move to space root",
            step: "Next state",
            grouped: "Grouped with",
            schedules: "Schedules",
            library: "Library",
            chats: [
                "Office chair order",
                "Get the September invoice",
                "Pay the maintenance fee",
                "Weekly summary page",
            ],
            attach: "Add to \u{2018}Get the September invoice\u{2019}",
            save: "Save to Library as scraps",
            invalid: "Can't drop here",
            more: [
                "Travel plan",
                "Reading list",
                "Release notes",
                "Tax documents",
                "Gift ideas",
                "Moving checklist",
            ],
        },
        Copy {
            rows: [
                "데스크톱 앱 다듬기",
                "주간 회고",
                "여행 계획",
                "읽을거리",
                "릴리스 노트",
            ],
            group: "함께 묶기",
            root: "스페이스 최상위로 이동",
            step: "다음 상태",
            grouped: "함께 묶음:",
            schedules: "예약 작업",
            library: "서랍",
            chats: [
                "사무용 의자 주문",
                "9월 청구서 받기",
                "관리비 이체",
                "주간 요약 페이지",
            ],
            attach: "\u{2018}9월 청구서 받기\u{2019}에 첨부",
            save: "서랍에 스크랩으로 저장",
            invalid: "여기에는 놓을 수 없어요",
            more: [
                "여행 계획",
                "읽을거리",
                "릴리스 노트",
                "세금 서류",
                "선물 아이디어",
                "이사 체크리스트",
            ],
        },
    )
}
