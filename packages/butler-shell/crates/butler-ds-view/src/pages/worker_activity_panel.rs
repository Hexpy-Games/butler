//! WorkerActivityPanel.showcase.tsx: the panel attached to the composer (its one-line collapsed
//! summary) and standing alone with a finished worker.
use butler_ds::ui::blocks::worker_activity::{WorkerActivityPanel, WorkerActivityRow};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use super::attached_composer::attached;
use crate::copy::Lang;

struct Worker {
    title: &'static str,
    description: &'static str,
    meta: &'static str,
    phase: &'static str,
    depth: usize,
}

struct Copy {
    heading: &'static str,
    summary: &'static str,
    workers: [Worker; 3],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            heading: "Workers",
            summary: "Worker 1 Executing: Reading project files and 1 more",
            workers: [
                Worker {
                    title: "Worker 1",
                    description: "Reading project files and extracting implementation notes.",
                    meta: "Executing",
                    phase: "executing",
                    depth: 0,
                },
                Worker {
                    title: "Worker 2",
                    description: "Reviewing the gathered evidence.",
                    meta: "Verifying",
                    phase: "verifying",
                    depth: 1,
                },
                Worker {
                    title: "Worker 3",
                    description: "Wrote the migration plan.",
                    meta: "Complete",
                    phase: "complete",
                    depth: 0,
                },
            ],
        },
        Copy {
            heading: "Worker",
            summary: "Worker 1 실행 중: 프로젝트 파일 읽는 중 외 1개",
            workers: [
                Worker {
                    title: "Worker 1",
                    description: "프로젝트 파일을 읽고 구현 메모를 뽑는 중입니다.",
                    meta: "실행 중",
                    phase: "executing",
                    depth: 0,
                },
                Worker {
                    title: "Worker 2",
                    description: "모은 근거를 검토하는 중입니다.",
                    meta: "검증 중",
                    phase: "verifying",
                    depth: 1,
                },
                Worker {
                    title: "Worker 3",
                    description: "마이그레이션 계획을 작성했습니다.",
                    meta: "완료",
                    phase: "complete",
                    depth: 0,
                },
            ],
        },
    )
}

fn panel(lang: Lang, id: &'static str, count: usize) -> WorkerActivityPanel {
    let c = copy(lang);
    let mut panel = WorkerActivityPanel::new(id)
        .heading(c.heading)
        .collapsed_summary(c.summary);
    for (index, worker) in c.workers.iter().take(count).enumerate() {
        panel = panel.item(
            WorkerActivityRow::new(format!("worker-{}", index + 1), worker.title)
                .description(worker.description)
                .meta(worker.meta)
                .phase(worker.phase)
                .depth(worker.depth),
        );
    }
    panel
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Attached to the composer",
            render: |lang, window, cx| attached_panel(lang, window, cx),
        },
        Story {
            name: "Standalone with a finished worker",
            render: |lang, _, _| panel(lang, "worker-panel-standalone", 3).into_any_element(),
        },
    ]
}

fn attached_panel(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    attached(
        lang,
        "worker-composer",
        panel(lang, "worker-panel-attached", 2),
        window,
        cx,
    )
}
