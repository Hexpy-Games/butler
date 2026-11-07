//! TodoProgressPanel.showcase.tsx: the plan steps attached to the composer and every state.
use butler_ds::ui::blocks::todo_progress_panel::{TodoItem, TodoProgressPanel, TodoState};
use gpui::IntoElement as _;

use super::Story;
use super::attached_composer::attached;
use crate::copy::Lang;

struct Copy {
    heading: &'static str,
    steps: [(&'static str, TodoState, &'static str); 7],
    stopped: &'static str,
}

fn copy(lang: Lang) -> Copy {
    use TodoState::{Blocked, Completed, CorrectionRequired, Pending, Reviewing, Running, Skipped};
    lang.pick(
        Copy {
            heading: "Steps",
            steps: [
                ("Understand the request", Completed, "Done"),
                ("Inspect the settings pages", Running, "Running"),
                ("Review the section header spacing", Reviewing, "Reviewing"),
                (
                    "Fix the drifted card inset",
                    CorrectionRequired,
                    "Needs correction",
                ),
                ("Wait for the S7 branch", Blocked, "Blocked"),
                ("Skip the superseded screenshot pass", Skipped, "Skipped"),
                ("Prepare the final answer", Pending, "Pending"),
            ],
            stopped: "Stopped by the user",
        },
        Copy {
            heading: "진행 단계",
            steps: [
                ("요청 이해하기", Completed, "완료"),
                ("설정 페이지 살펴보기", Running, "진행 중"),
                ("섹션 헤더 간격 검토", Reviewing, "검토 중"),
                ("어긋난 카드 여백 고치기", CorrectionRequired, "수정 필요"),
                ("S7 브랜치 기다리기", Blocked, "막힘"),
                ("대체된 스크린샷 작업 건너뛰기", Skipped, "건너뜀"),
                ("최종 답변 준비", Pending, "대기"),
            ],
            stopped: "사용자가 중지함",
        },
    )
}

fn items(c: &Copy, count: usize) -> Vec<TodoItem> {
    c.steps
        .iter()
        .take(count)
        .enumerate()
        .map(|(index, (title, state, label))| {
            TodoItem::new(format!("step-{index}"), *title, *state, *label)
        })
        .collect()
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Attached to the composer",
            render: |lang, window, cx| {
                let c = copy(lang);
                let panel = TodoProgressPanel::new("todo-attached", c.heading).items(items(&c, 3));
                attached(lang, "todo-composer", panel, window, cx)
            },
        },
        Story {
            name: "Every state",
            render: |lang, _, _| {
                let c = copy(lang);
                let mut all = items(&c, 7);
                all.push(TodoItem::new(
                    "stopped",
                    c.stopped,
                    TodoState::Stopped,
                    c.stopped,
                ));
                TodoProgressPanel::new("todo-every", c.heading)
                    .items(all)
                    .into_any_element()
            },
        },
    ]
}
