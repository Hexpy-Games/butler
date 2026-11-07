//! The copy of the session's step order section (`canon.order`, `canon.done`).
use std::rc::Rc;

use butler_ds::ui::blocks::step_sortable_list::StepSortableLabels;
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct CanonOrder {
    /// canon.order.chain: user_message, schedule, detach
    pub(crate) chain_user_message: &'static str,
    pub(crate) chain_schedule: &'static str,
    pub(crate) chain_detach: &'static str,
    /// canon.order.status: running, failed, unfinished, done
    pub(crate) status_running: &'static str,
    pub(crate) status_failed: &'static str,
    pub(crate) status_unfinished: &'static str,
    pub(crate) status_done: &'static str,
    /// canon.order.heldBy, join, newStep
    pub(crate) held_by: &'static str,
    pub(crate) join: &'static str,
    pub(crate) new_step: &'static str,
    /// canon.order.startNow, unstack, remove
    pub(crate) start_now: &'static str,
    pub(crate) unstack: &'static str,
    pub(crate) remove: &'static str,
    /// canon.order.failed
    pub(crate) failed: &'static str,
    /// canon.order.changed
    pub(crate) changed: &'static str,
}

const KO: CanonOrder = CanonOrder {
    chain_user_message: "요청한 과제",
    chain_schedule: "예약 작업",
    chain_detach: "바로 시작한 과제",
    status_running: "진행 중",
    status_failed: "막힘",
    status_unfinished: "답 기다림",
    status_done: "완료",
    held_by: "앞 과제가 막힘",
    join: "함께 진행",
    new_step: "새 단계로",
    start_now: "지금 시작",
    unstack: "묶음 풀기",
    remove: "삭제",
    failed: "순서를 바꾸지 못했습니다",
    changed: "순서가 바뀌어 다시 불러왔습니다",
};

const EN: CanonOrder = CanonOrder {
    chain_user_message: "Requested",
    chain_schedule: "Schedule",
    chain_detach: "Started now",
    status_running: "Running",
    status_failed: "Blocked",
    status_unfinished: "Needs reply",
    status_done: "Done",
    held_by: "Blocked earlier",
    join: "Run together",
    new_step: "New step",
    start_now: "Start now",
    unstack: "Unstack",
    remove: "Delete",
    failed: "Couldn't change the order",
    changed: "Order changed; reloaded",
};

impl CanonOrder {
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }

    /// canon.order.after: the word and the name.
    pub(crate) fn after(lang: Lang, title: &str) -> (&'static str, String) {
        match lang {
            Lang::Ko => ("끝나면:", format!("‘{title}’")),
            Lang::En => ("After:", format!("‘{title}’")),
        }
    }

    /// canon.order.afterStack
    pub(crate) fn after_stack(lang: Lang, title: &str, count: usize) -> (&'static str, String) {
        match lang {
            Lang::Ko => ("끝나면:", format!("‘{title} 외 {count}건’")),
            Lang::En => ("After:", format!("‘{title}’ +{count} more")),
        }
    }

    /// canon.order.more
    pub(crate) fn more(lang: Lang, count: usize) -> String {
        match lang {
            Lang::Ko => format!("외 {count}건"),
            Lang::En => format!("+{count} more"),
        }
    }

    /// canon.order.menu
    pub(crate) fn menu(lang: Lang, title: &str) -> String {
        match lang {
            Lang::Ko => format!("‘{title}’ 메뉴"),
            Lang::En => format!("{title} menu"),
        }
    }

    /// canon.done
    pub(crate) fn done(lang: Lang, done: i64, total: i64) -> String {
        match lang {
            Lang::Ko => format!("{done}/{total} 완료"),
            Lang::En => format!("{done}/{total} done"),
        }
    }

    /// canon.order.drag (the deck labels have no DS counterpart).
    pub(crate) fn drag(lang: Lang) -> StepSortableLabels {
        let ko = lang == Lang::Ko;
        let placed = |ko_text: fn(&str, &str, usize) -> String,
                      en_text: fn(&str, &str, usize) -> String| {
            Rc::new(if ko { ko_text } else { en_text }) as Rc<dyn Fn(&str, &str, usize) -> String>
        };
        let named = |ko_text: fn(&str) -> String, en_text: fn(&str) -> String| {
            Rc::new(if ko { ko_text } else { en_text }) as Rc<dyn Fn(&str) -> String>
        };
        StepSortableLabels {
            grip: named(|item| format!("‘{item}’ 옮기기"), |item| format!("Move {item}")),
            stack: Rc::new(move |front: &str, count: usize| {
                if ko {
                    format!("{front} 외 {}건", count - 1)
                } else {
                    format!("{front} and {} more", count - 1)
                }
            }),
            lifted: placed(
                |item, chain, step| format!("‘{item}’ 옮기는 중입니다. {chain}, {step}단계."),
                |item, chain, step| format!("Picked up {item}. {chain}, step {step}."),
            ),
            new_step: placed(
                |item, chain, step| format!("‘{item}’: {chain}의 새 {step}단계."),
                |item, chain, step| format!("{item}: new step {step} in {chain}."),
            ),
            join: placed(
                |item, chain, step| format!("‘{item}’: {chain} {step}단계와 함께 진행."),
                |item, chain, step| format!("{item}: together with step {step} in {chain}."),
            ),
            dropped: placed(
                |item, chain, step| format!("‘{item}’을(를) {chain} {step}단계로 옮겼습니다."),
                |item, chain, step| format!("Dropped {item} in {chain}, step {step}."),
            ),
            cancelled: named(
                |item| format!("‘{item}’ 옮기기를 취소했습니다."),
                |item| format!("Move of {item} cancelled."),
            ),
            unchanged: named(
                |item| format!("‘{item}’은(는) 그대로입니다."),
                |item| format!("{item} stays where it was."),
            ),
        }
    }
}
