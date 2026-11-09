//! AutomationRunList.showcase.tsx: runs with state icons, the product rows (state label and age
//! only) and the empty state.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::activity_feed::ActivityFeedItem;
use butler_ds::ui::blocks::automation_run_list::AutomationRunList;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::spinner::Spinner;
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    runs: &'static str,
    empty: &'static str,
    completed: &'static str,
    running: &'static str,
    failed: &'static str,
    brief: &'static str,
    error: &'static str,
    today: &'static str,
    now: &'static str,
    yesterday: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            runs: "Runs",
            empty: "No runs yet.",
            completed: "Completed",
            running: "Running",
            failed: "Failed",
            brief: "Brief generated",
            error: "Model provider timed out",
            today: "today",
            now: "now",
            yesterday: "yesterday",
        },
        Copy {
            runs: "실행 기록",
            empty: "아직 실행 기록이 없습니다.",
            completed: "완료",
            running: "실행 중",
            failed: "실패",
            brief: "브리핑 생성됨",
            error: "모델 제공자 응답 시간 초과",
            today: "오늘",
            now: "방금",
            yesterday: "어제",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Runs with state icons",
            render: with_icons,
        },
        Story {
            name: "Product rows (labels only)",
            render: labels_only,
        },
        Story {
            name: "Empty",
            render: empty,
        },
    ]
}

fn with_icons(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    AutomationRunList::new(
        "arl-icons",
        vec![
            ActivityFeedItem::new("run-3", c.running)
                .icon(Spinner::new("arl-spin"))
                .meta(c.now),
            ActivityFeedItem::new("run-2", c.completed)
                .icon(icon(Icon::CheckIcon, IconSize::Md, ds))
                .description(c.brief)
                .meta(c.today),
            ActivityFeedItem::new("run-1", c.failed)
                .icon(icon(Icon::CircleX, IconSize::Md, ds))
                .description(c.error)
                .meta(c.yesterday),
        ],
    )
    .title(c.runs)
    .into_any_element()
}

fn labels_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    AutomationRunList::new(
        "arl-labels",
        vec![
            ActivityFeedItem::new("run-2", c.completed).meta(c.today),
            ActivityFeedItem::new("run-1", c.failed).meta(c.yesterday),
        ],
    )
    .title(c.runs)
    .empty_label(c.empty)
    .into_any_element()
}

fn empty(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    AutomationRunList::new("arl-empty", Vec::new())
        .title(c.runs)
        .empty_label(c.empty)
        .into_any_element()
}
