//! `ProjectOverviewPanel`: what is done, open and blocked, and the work that remains. The
//! project's briefing panels are in [`briefing`].
pub(super) mod briefing;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::metric_card::{MetricCard, MetricGrid};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::card::Card;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Inline, Preset, Responsive, Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::InteractiveElement as _;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString};

use super::copy::{Words, words};
use super::selection::source_document;
use crate::ui::manage::{Action, Pick};
use crate::ui::source::wire::{
    DashboardOverview, DashboardOverviewReady, DashboardWorkCard, ProjectDashboardDocument,
    ProjectDashboardDocumentKind, ProjectDashboardDocumentType,
};

/// How many remaining works the overview lists.
const SHOWN: usize = 4;

/// What the panel draws with: the dashboard's overview, and what its cards do.
pub(super) struct Overview<'a> {
    pub(super) data: Option<&'a DashboardOverview>,
    pub(super) project: &'a str,
    pub(super) select: &'a Pick<ProjectDashboardDocument>,
    pub(super) show_all: &'a Action,
}

/// `grid-template-columns: 1 | main-aside` of the panel's two columns.
fn main_aside(id: &'static str) -> Grid {
    Grid::new(id)
        .columns(Columns::Responsive(Responsive {
            compact: None,
            base: Preset::Fixed(1),
            wide: Some(Preset::MainAside),
        }))
        .gap(Space::Xl)
}

impl Overview<'_> {
    /// `ProjectOverviewPanel`; `aside` is the important materials.
    pub(super) fn render(&self, aside: Option<AnyElement>, cx: &App) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        match self.data {
            Some(DashboardOverview::Ready(ready)) => self.ready(ready, aside, copy, cx),
            other => {
                let unbound = matches!(other, Some(DashboardOverview::Unavailable { reason }) if reason == "unbound");
                let text = if unbound {
                    copy.unbound
                } else {
                    copy.unavailable
                };
                main_aside("overview-unavailable")
                    .child(
                        Section::new("overview-position")
                            .title(copy.position)
                            .child(Typo::body(text)),
                    )
                    .children(aside)
                    .into_any_element()
            }
        }
    }

    fn ready(
        &self,
        overview: &DashboardOverviewReady,
        aside: Option<AnyElement>,
        copy: &'static Words,
        cx: &App,
    ) -> AnyElement {
        let count = |key: &str| overview.progress.get(key).copied().unwrap_or(0);
        #[allow(clippy::cast_precision_loss, reason = "a count shown as a number")]
        let metric = |id: &'static str, key: &str, label: &'static str| {
            MetricCard::number(id, count(key) as f64, label)
        };
        let mut facts = vec![
            copy.recorded.to_owned(),
            format!("{} {}", copy.registered, overview.total_works),
        ];
        for (key, label) in [("abandoned", copy.abandoned), ("unknown", copy.unknown)] {
            if count(key) > 0 {
                facts.push(format!("{label} {}", count(key)));
            }
        }
        let facts = facts.join(" · ");
        let progress = Stack::new().gap(Space::Sm).child(
            MetricGrid::new("overview-progress")
                .columns(Columns::fixed(3))
                .child(metric("overview-completed", "completed", copy.completed))
                .child(metric("overview-open", "open", copy.open))
                .child(metric("overview-blocked", "blocked", copy.blocked)),
        );
        let progress = progress.child(Typo::caption(facts).tone(Tone::Secondary));
        let remaining = self.remaining(overview, copy, cx);
        crate::ui::widgets::anchor(
            gpui::div().id("project-overview-facts"),
            "project-overview-facts",
        )
        .child(
            Stack::new().gap(Space::Xl).child(progress).child(
                main_aside("overview-columns")
                    .child(remaining)
                    .children(aside),
            ),
        )
        .into_any_element()
    }

    /// The remaining work: its first cards, and the way to the board.
    fn remaining(
        &self,
        overview: &DashboardOverviewReady,
        copy: &'static Words,
        cx: &App,
    ) -> Section {
        let cards = overview
            .remaining
            .iter()
            .take(SHOWN)
            .map(|work| self.card(work, &overview.source_revision, copy, cx))
            .collect::<Vec<_>>();
        let mut section = Section::new("overview-remaining")
            .title(copy.remaining)
            .child(
                Grid::new("overview-remaining-grid")
                    .columns(Columns::AUTO_FIT)
                    .gap(Space::Md)
                    .children(cards),
            );
        if overview.remaining.is_empty() {
            let unknown = overview.progress.get("unknown").copied().unwrap_or(0) > 0;
            section = section.child(Typo::body(if unknown {
                copy.unavailable
            } else {
                copy.no_remaining
            }));
        }
        let show_all = self.show_all.clone();
        let label = format!(
            "{} · {}",
            (copy.loaded)(
                overview.remaining.len().min(SHOWN),
                overview.remaining_count
            ),
            copy.work
        );
        section.child(
            Button::new("overview-show-all")
                .variant(Variant::Borderless)
                .text(label)
                .on_click(move |_, window, cx| show_all(window, cx)),
        )
    }

    /// One remaining work: opens its record.
    fn card(
        &self,
        work: &DashboardWorkCard,
        source_revision: &str,
        copy: &'static Words,
        cx: &App,
    ) -> Card {
        let ds = Ds::get(cx);
        let document = source_document(
            &work.id,
            self.project,
            Some(work.revision.as_deref().unwrap_or(source_revision)),
            &work.title,
            ProjectDashboardDocumentKind::Plan,
            ProjectDashboardDocumentType::Work,
            &work.updated_at,
        );
        let select = self.select.clone();
        let (glyph, status) = if work.execution_status == "blocked" {
            (Icon::AlertCircle, copy.blocked)
        } else {
            (Icon::Circle, status_label(&work.execution_status, copy))
        };
        let line = match &work.task_progress {
            Some(tasks) => format!("{status} · {} {}/{}", copy.tasks, tasks.done, tasks.total),
            None => status.to_owned(),
        };
        Card::new(SharedString::from(format!("overview-work-{}", work.id)))
            .interactive()
            .on_click(move |_, window, cx| select(document.clone(), window, cx))
            .child(
                Stack::new()
                    .gap(Space::Md)
                    .child(
                        Typo::body(work.title.clone())
                            .line_clamp(2)
                            .wrap(Wrap::Anywhere),
                    )
                    .child(
                        Inline::new()
                            .gap(Space::Xs)
                            .child(icon(glyph, IconSize::Md, ds))
                            .child(Typo::caption(line).tone(Tone::Secondary)),
                    ),
            )
    }
}

/// `copy[work.executionStatus]`
fn status_label(status: &str, copy: &'static Words) -> &'static str {
    match status {
        "completed" => copy.completed,
        "open" => copy.open,
        "blocked" => copy.blocked,
        "abandoned" => copy.abandoned,
        _ => copy.unknown,
    }
}
