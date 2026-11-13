//! The board's copy. Each field names its `packages/butler-i18n` key.
use std::rc::Rc;

use butler_ds::ui::blocks::kanban_board::KanbanDragLabels;
use butler_ds::ui::context::Lang;

use crate::ui::source::wire::{CanonStatus, EpicCard};

pub(super) struct Words {
    /// canon.backlog
    pub(super) backlog: &'static str,
    /// canon.newEpic
    pub(super) new_epic: &'static str,
    /// canon.newPlan
    pub(super) new_plan: &'static str,
    /// canon.plan
    pub(super) plan: &'static str,
    /// canon.searchPlan
    pub(super) search_plan: &'static str,
    /// canon.noResults
    pub(super) no_results: &'static str,
    /// canon.edit
    pub(super) edit: &'static str,
    /// canon.running
    pub(super) running: &'static str,
    /// canon.reordered
    pub(super) reordered: &'static str,
    /// canon.blockedLane
    pub(super) blocked_lane: &'static str,
    /// canon.previousLanes
    pub(super) previous_lanes: &'static str,
    /// canon.nextLanes
    pub(super) next_lanes: &'static str,
    /// feedback.dashboardLoading
    pub(super) loading: &'static str,
    /// feedback.dashboardRetry
    pub(super) retry_hint: &'static str,
    /// feedback.retry
    pub(super) retry: &'static str,
    /// interfaceFeedback.requestFailed
    pub(super) request_failed: &'static str,
    /// canon.statuses: planned, in_progress, in_review, blocked, done, cancelled
    statuses: [&'static str; 6],
    /// canon.done
    done: fn(usize, usize) -> String,
    /// canon.due
    due: fn(&str) -> String,
    /// canon.tasks
    tasks: fn(i64, i64) -> String,
    /// canon.ordinal
    ordinal: fn(usize) -> String,
    /// canon.moved
    moved: fn(&str) -> String,
    /// canon.cardStatusChanged
    card_status_changed: fn(&str, &str) -> String,
    lang: Lang,
}

static KO: Words = Words {
    backlog: "백로그",
    new_epic: "새 과제",
    new_plan: "새 계획",
    plan: "계획",
    search_plan: "계획 검색",
    no_results: "검색 결과 없음",
    edit: "고치기",
    running: "진행 중에는 완료할 수 없습니다",
    reordered: "과제 순서를 바꿨습니다",
    blocked_lane: "막힘",
    previous_lanes: "이전 열",
    next_lanes: "다음 열",
    loading: "프로젝트 정보를 불러오는 중입니다.",
    retry_hint: "연결을 확인한 뒤 다시 시도해 주세요.",
    retry: "다시 시도",
    request_failed: "요청을 처리하지 못했습니다.",
    statuses: ["예정", "진행 중", "검토 중", "막힘", "완료", "취소됨"],
    done: |done, total| format!("{done}/{total} 완료"),
    due: |date| format!("{date}까지"),
    tasks: |done, total| format!("작업 {done}/{total}"),
    ordinal: |n| format!("{n}번째"),
    moved: |plan| format!("{plan}에 넣었습니다"),
    card_status_changed: |title, status| format!("‘{title}’ {status}"),
    lang: Lang::Ko,
};

static EN: Words = Words {
    backlog: "Backlog",
    new_epic: "New Epic",
    new_plan: "New Plan",
    plan: "Plan",
    search_plan: "Search plans",
    no_results: "No results",
    edit: "Edit",
    running: "Cannot complete while running",
    reordered: "Epic order changed",
    blocked_lane: "Blocked",
    previous_lanes: "Previous lanes",
    next_lanes: "Next lanes",
    loading: "Loading project information…",
    retry_hint: "Check your connection and try again.",
    retry: "Try again",
    request_failed: "Request failed.",
    statuses: [
        "Planned",
        "In progress",
        "In review",
        "Blocked",
        "Done",
        "Cancelled",
    ],
    done: |done, total| format!("{done}/{total} done"),
    due: |date| format!("Due {date}"),
    tasks: |done, total| format!("Tasks {done}/{total}"),
    ordinal: |n| format!("No. {n}"),
    moved: |plan| format!("Moved to {plan}"),
    card_status_changed: |title, status| format!("‘{title}’ {status}"),
    lang: Lang::En,
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

impl Words {
    /// `canon.statuses[status]`; an unknown status has no label.
    pub(super) fn status(&self, status: CanonStatus) -> &'static str {
        match status {
            CanonStatus::Planned => self.statuses[0],
            CanonStatus::InProgress => self.statuses[1],
            CanonStatus::InReview => self.statuses[2],
            CanonStatus::Blocked => self.statuses[3],
            CanonStatus::Done => self.statuses[4],
            CanonStatus::Cancelled => self.statuses[5],
            CanonStatus::Unknown => "",
        }
    }

    pub(super) fn tasks(&self, done: i64, total: i64) -> String {
        (self.tasks)(done, total)
    }

    pub(super) fn ordinal(&self, n: usize) -> String {
        (self.ordinal)(n)
    }

    pub(super) fn moved(&self, plan: &str) -> String {
        (self.moved)(plan)
    }

    pub(super) fn card_status_changed(&self, title: &str, status: &str) -> String {
        (self.card_status_changed)(title, status)
    }

    /// The lane name of a status (`blockedLane` for blocked, `statuses` for the rest).
    pub(super) fn lane_label(&self, status: CanonStatus) -> &'static str {
        if status == CanonStatus::Blocked {
            self.blocked_lane
        } else {
            self.status(status)
        }
    }

    /// `planCaption`: "done/total", and the due date when the plan has one.
    pub(super) fn plan_caption(&self, works: &[EpicCard], due_on: Option<&str>) -> String {
        let done = works
            .iter()
            .filter(|epic| epic.canon_status == CanonStatus::Done)
            .count();
        let progress = (self.done)(done, works.len());
        match due_on {
            Some(due_on) => format!("{progress} · {}", (self.due)(&self.due_date(due_on))),
            None => progress,
        }
    }

    /// `Intl.DateTimeFormat(locale, { month: "long", day: "numeric" })` of a `YYYY-MM-DD` date.
    fn due_date(&self, due_on: &str) -> String {
        const MONTHS: [&str; 12] = [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ];
        let mut parts = due_on.splitn(3, '-');
        let month = parts.nth(1).and_then(|part| part.parse::<usize>().ok());
        let day = parts.next().and_then(|part| part.parse::<usize>().ok());
        match (month, day) {
            (Some(month @ 1..=12), Some(day)) => match self.lang {
                Lang::Ko => format!("{month}월 {day}일"),
                Lang::En => format!("{} {day}", MONTHS[month - 1]),
            },
            _ => due_on.to_owned(),
        }
    }
}

/// `canon.drag` as the Kanban scope's announcements.
pub(super) fn drag_labels(lang: Lang) -> KanbanDragLabels {
    let mut labels = KanbanDragLabels::default();
    match lang {
        Lang::Ko => {
            labels.instructions =
                "스페이스로 카드를 들고, 화살표로 옮긴 뒤 스페이스로 놓습니다. Esc로 취소합니다."
                    .into();
            labels.role_description = "옮길 수 있는 과제".into();
            labels.lifted = Rc::new(|item, lane, position| {
                format!("‘{item}’ 카드를 들었습니다. {lane}, {position}번째.")
            });
            labels.over =
                Rc::new(|item, lane, position| format!("‘{item}’: {lane}, {position}번째."));
            labels.dropped = Rc::new(|item, lane, position| {
                format!("‘{item}’ 카드를 놓았습니다. {lane}, {position}번째.")
            });
            labels.cancelled = Rc::new(|item| format!("‘{item}’ 이동을 취소했습니다."));
            labels.unchanged = Rc::new(|item| format!("‘{item}’ 자리는 그대로입니다."));
        }
        Lang::En => {
            labels.instructions =
                "Press Space to pick the card up. Use arrows to move it, Space to drop it, Escape to cancel."
                    .into();
            labels.role_description = "draggable Epic".into();
            labels.lifted = Rc::new(|item, lane, position| {
                format!("Picked up {item}. {lane}, position {position}.")
            });
            labels.over =
                Rc::new(|item, lane, position| format!("{item}: {lane}, position {position}."));
            labels.dropped = Rc::new(|item, lane, position| {
                format!("Dropped {item} in {lane}, position {position}.")
            });
            labels.cancelled = Rc::new(|item| format!("Move of {item} cancelled."));
            labels.unchanged = Rc::new(|item| format!("{item} stays where it was."));
        }
    }
    labels
}
