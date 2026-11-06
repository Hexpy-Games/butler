//! Tabs.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    summary: &'static str,
    files: &'static str,
    workers: &'static str,
    sections: &'static str,
    summary_hint: &'static str,
    files_hint: &'static str,
    workers_hint: &'static str,
    overview: &'static str,
    work: &'static str,
    materials: &'static str,
    history: &'static str,
    statistics: &'static str,
    panel: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            summary: "Summary",
            files: "Files",
            workers: "Workers",
            sections: "Inspector sections",
            summary_hint: "Right-panel tab surface.",
            files_hint: "Changed files and artifacts.",
            workers_hint: "Worker activity and review state.",
            overview: "Overview",
            work: "Work",
            materials: "Materials",
            history: "History",
            statistics: "Statistics",
            panel: "Panel content",
        },
        Copy {
            summary: "요약",
            files: "파일",
            workers: "Worker",
            sections: "인스펙터 섹션",
            summary_hint: "오른쪽 패널 탭 표면입니다.",
            files_hint: "변경된 파일과 산출물.",
            workers_hint: "Worker 활동과 검토 상태.",
            overview: "개요",
            work: "작업",
            materials: "자료",
            history: "기록",
            statistics: "통계",
            panel: "패널 내용",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Inspector sections (default, stretch)",
            render: inspector,
        },
        Story {
            name: "Page navigation (line)",
            render: navigation,
        },
    ]
}

/// The selected tab, held in the page's state as Radix keeps it for `defaultValue`.
fn selected(
    id: &'static str,
    initial: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (SharedString, impl Fn(&str, &mut Window, &mut App) + 'static) {
    let state = window.use_keyed_state(id, cx, move |_, _| SharedString::from(initial));
    let value = state.read(cx).clone();
    (value, move |next: &str, _: &mut Window, cx: &mut App| {
        let next = SharedString::from(next.to_owned());
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
    })
}

fn inspector(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = selected("tabs-inspector", "summary", window, cx);
    let probe_name = format!("tab-inspector-{value}");
    Stack::new()
        .child(
            Tabs::new("tabs-inspector")
                .value(value)
                .on_value_change(change)
                .list(TabsList::new(c.sections).stretch().triggers([
                    Trigger::new("summary", c.summary).icon(Icon::Command),
                    Trigger::new("files", c.files).icon(Icon::FileText),
                    Trigger::new("workers", c.workers).icon(Icon::Blocks),
                ]))
                .panel(
                    "summary",
                    Stack::new()
                        .gap(Space::Xs)
                        .child(Typo::panel_section_title(c.summary))
                        .child(Typo::caption(c.summary_hint)),
                )
                .panel("files", Typo::caption(c.files_hint))
                .panel("workers", Typo::caption(c.workers_hint)),
        )
        .child(probe(probe_name))
        .into_any_element()
}

fn navigation(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = selected("tabs-navigation", "overview", window, cx);
    let tabs = [
        ("overview", Icon::LayoutDashboard, c.overview),
        ("work", Icon::ListChecks, c.work),
        ("materials", Icon::Folder, c.materials),
        ("history", Icon::History, c.history),
        ("statistics", Icon::Activity, c.statistics),
    ];
    let probe_name = format!("tab-navigation-{value}");
    let mut root = Tabs::new("tabs-navigation")
        .value(value)
        .on_value_change(change)
        .list(
            TabsList::new(c.sections)
                .variant(ListVariant::Line)
                .triggers(tabs.map(|(value, glyph, label)| Trigger::new(value, label).icon(glyph))),
        );
    for (value, _, label) in tabs {
        root = root.panel(
            value,
            Typo::caption(format!("{label} · {}", c.panel)).tone(Tone::Secondary),
        );
    }
    Stack::new()
        .child(root)
        .child(probe(probe_name))
        .into_any_element()
}
