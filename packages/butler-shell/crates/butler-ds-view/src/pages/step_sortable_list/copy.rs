//! The copy of the StepSortableList showcase (`StepSortableList.fixtures.ts`), in English and
//! Korean, and the Korean announcements a product container passes.
use std::rc::Rc;

use butler_ds::ui::blocks::step_sortable_list::StepSortableLabels;

use crate::copy::Lang;

pub(super) struct Copy {
    pub(super) chains: [&'static str; 2],
    pub(super) more: fn(usize) -> String,
    pub(super) menu_label: fn(&str) -> String,
    /// Start now, Unstack, Delete.
    pub(super) menu: [&'static str; 3],
    pub(super) after: fn(&str) -> String,
    pub(super) join: &'static str,
    pub(super) new_step: &'static str,
    /// Running, in review, waiting, paused, done, failed.
    pub(super) status: [&'static str; 6],
    pub(super) titles: [&'static str; 6],
    pub(super) progress: [&'static str; 6],
    pub(super) result: [&'static str; 6],
    pub(super) time: [&'static str; 6],
    pub(super) not_started: &'static str,
    pub(super) paused_by_you: &'static str,
    pub(super) paused_before: &'static str,
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(english(), korean())
}

fn english() -> Copy {
    Copy {
        chains: ["Report", "Research"],
        more: |count| format!("+{count} more"),
        menu_label: |title| format!("{title} menu"),
        menu: ["Start now", "Unstack", "Delete"],
        after: |title| format!("After {title}"),
        join: "Run together",
        new_step: "New step",
        status: [
            "Running",
            "In review",
            "Waiting",
            "Paused",
            "Done",
            "Failed",
        ],
        titles: [
            "Write the report",
            "Turn it into slides",
            "Make a summary",
            "Write the talk script",
            "Research competitors",
            "Send the summary email",
        ],
        progress: [
            "Drafting chapter 3",
            "Building slide 6 of 12",
            "Picking the key points",
            "Drafting the opening",
            "Reading 7 sources",
            "Drafting the email",
        ],
        result: [
            "12-page report",
            "12 slides",
            "One-page summary",
            "5-minute script",
            "9 sources compared",
            "Sent to 3 people",
        ],
        time: ["12 min", "6 min", "3 min", "5 min", "4 min", "1 min"],
        not_started: "Not started",
        paused_by_you: "You paused it",
        paused_before: "Previous step paused",
    }
}

fn korean() -> Copy {
    Copy {
        chains: ["보고서", "조사"],
        more: |count| format!("외 {count}건"),
        menu_label: |title| format!("\u{2018}{title}\u{2019} 메뉴"),
        menu: ["지금 시작", "묶음 풀기", "삭제"],
        after: |title| format!("{title} 끝나면"),
        join: "함께 진행",
        new_step: "새 단계로",
        status: ["진행 중", "검토 중", "대기", "멈춤", "완료", "실패"],
        titles: [
            "보고서 작성",
            "PPT로 정리",
            "요약본 만들기",
            "발표 대본 쓰기",
            "경쟁사 자료 조사",
            "요약 메일 보내기",
        ],
        progress: [
            "3장 초안 쓰는 중",
            "슬라이드 12장 중 6장째",
            "핵심 문장 고르는 중",
            "도입부 쓰는 중",
            "자료 7건 읽는 중",
            "메일 초안 쓰는 중",
        ],
        result: [
            "보고서 12쪽",
            "슬라이드 12장",
            "요약 1쪽",
            "대본 5분 분량",
            "자료 9건 비교",
            "3명에게 보냄",
        ],
        time: ["12분", "6분", "3분", "5분", "4분", "1분"],
        not_started: "시작 전",
        paused_by_you: "직접 멈춤",
        paused_before: "앞 단계 멈춤",
    }
}

/// Korean announcements and grip names, as a product container passes them (`KO_STEP_LABELS`).
pub(super) fn ko_labels() -> StepSortableLabels {
    StepSortableLabels {
        grip: Rc::new(|item: &str| format!("\u{2018}{item}\u{2019} 옮기기")),
        stack: Rc::new(|front: &str, count: usize| format!("{front} 외 {}건", count - 1)),
        lifted: Rc::new(|item: &str, chain: &str, step: usize| {
            format!("\u{2018}{item}\u{2019} 옮기는 중입니다. {chain}, {step}단계.")
        }),
        new_step: Rc::new(|item: &str, chain: &str, step: usize| {
            format!("\u{2018}{item}\u{2019}: {chain}의 새 {step}단계.")
        }),
        join: Rc::new(|item: &str, chain: &str, step: usize| {
            format!("\u{2018}{item}\u{2019}: {chain} {step}단계와 함께 진행.")
        }),
        dropped: Rc::new(|item: &str, chain: &str, step: usize| {
            format!("\u{2018}{item}\u{2019}을(를) {chain} {step}단계로 옮겼습니다.")
        }),
        cancelled: Rc::new(|item: &str| format!("\u{2018}{item}\u{2019} 옮기기를 취소했습니다.")),
        unchanged: Rc::new(|item: &str| format!("\u{2018}{item}\u{2019}은(는) 그대로입니다.")),
    }
}
