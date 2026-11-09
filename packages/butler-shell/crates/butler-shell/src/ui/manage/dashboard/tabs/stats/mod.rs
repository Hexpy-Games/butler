//! `management/ProjectStatisticsPanel.tsx`, `hooks/useProjectStatistics.ts` and
//! `projectStatisticsContext.ts`: the period, the one statistics read, and the groups under it.
//! The dashboard keeps the panel across `publicRevision` changes and calls `set_revision`, which
//! refetches with the chosen period (React's refresh).
mod activity;
mod chart;
mod sources;
mod work;

use std::rc::Rc;

use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{
    Border, Box as Frame, Columns, Grid, Preset, Radius, Responsive, Space, Stack,
};
use butler_ds::ui::section::Section;
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Window, div,
};

use self::activity::ActivityStatistics;
use self::chart::{Heading, StatChart};
use self::work::WorkStatistics;
use super::copy::{StatWords, words};
use super::docs::from_source;
use crate::ui::manage::Pick;
use crate::ui::manage::dashboard::DashboardCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{
    DashboardStatisticSeries, DashboardStatisticsView, ProjectDashboardDocument,
};
use crate::ui::widgets::anchor;

const PERIODS: [u32; 3] = [7, 30, 90];

/// The context of `ProjectStatisticsContext`: the answer and `openSource`.
pub(super) struct Stats {
    pub(super) data: DashboardStatisticsView,
    project: SharedString,
    select: Pick<ProjectDashboardDocument>,
    open_session: Pick<SharedString>,
}

impl Stats {
    /// `openSource`: a document opens in the dashboard's viewer, a conversation in the chat.
    pub(super) fn open(&self, key: &str, window: &mut Window, cx: &mut App) {
        let Some(item) = self.data.sources.get(key) else {
            return;
        };
        match (&item.source, &item.session) {
            (Some(source), _) => {
                let document = from_source(&self.project, source, &item.title, &item.at);
                (self.select)(document, window, cx);
            }
            (None, Some(session)) => {
                (self.open_session)(SharedString::from(session.id.clone()), window, cx);
            }
            (None, None) => {}
        }
    }
}

/// `Math.round(part / whole * 100)`, for a meter.
pub(super) fn pct(part: f64, whole: f64) -> f32 {
    #[expect(clippy::cast_possible_truncation, reason = "a percentage")]
    let value = (part / whole.max(1.) * 100.).round() as f32;
    value
}

/// A count as the float the meters divide.
pub(super) fn count(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

/// Everything built from one answer; a new answer builds it again (React's `key`).
struct Built {
    stats: Rc<Stats>,
    work: Entity<WorkStatistics>,
    activity: Entity<ActivityStatistics>,
    materials: Entity<StatChart>,
    outcomes: Entity<StatChart>,
    duration: Entity<StatChart>,
}

/// One stacked `ProjectStatisticChart`.
fn chart(
    stats: &Rc<Stats>,
    id: &str,
    heading: Heading,
    variants: Vec<(&'static str, DashboardStatisticSeries)>,
    cx: &mut Context<StatisticsPanel>,
) -> Entity<StatChart> {
    cx.new(|_| StatChart::new(id, heading, variants, true, stats.clone()))
}

/// `ProjectStatisticsPanel`
pub(crate) struct StatisticsPanel {
    ctx: DashboardCtx,
    period: u32,
    revision: String,
    built: Option<Built>,
    loading: bool,
    error: bool,
    request: u64,
}

impl StatisticsPanel {
    pub(crate) fn new(
        ctx: DashboardCtx,
        revision: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut panel = Self {
            ctx,
            period: 30,
            revision,
            built: None,
            loading: false,
            error: false,
            request: 0,
        };
        panel.load(cx);
        panel
    }

    /// `publicRevision` changed: read again for the period already chosen.
    pub(crate) fn set_revision(&mut self, revision: String, cx: &mut Context<Self>) {
        if revision != self.revision {
            self.revision = revision;
            self.load(cx);
        }
    }

    /// `GET /projects/{id}/dashboard/statistics?days&timezone`
    fn load(&mut self, cx: &mut Context<Self>) {
        self.request += 1;
        let request = self.request;
        self.loading = true;
        self.error = false;
        let (project, days) = (self.ctx.project.to_string(), self.period);
        // React sends the browser's zone (`Intl`); the platform reads the same host setting.
        let zone = butler_platform::time_zone::LocalZoneSource::current()
            .ok()
            .map(|source| source.name);
        fetch(
            cx,
            move |client| async move {
                client
                    .get_project_dashboard_statistics(&project, Some(days), zone.as_deref())
                    .await
            },
            move |this: &mut Self, result: Result<DashboardStatisticsView, Error>, cx| {
                this.loaded(request, result, cx);
            },
        );
    }

    fn loaded(
        &mut self,
        request: u64,
        result: Result<DashboardStatisticsView, Error>,
        cx: &mut Context<Self>,
    ) {
        if request != self.request {
            return;
        }
        self.loading = false;
        match result {
            Ok(data) => self.built = Some(self.build(data, cx)),
            Err(_) => self.error = true,
        }
    }

    fn build(&self, data: DashboardStatisticsView, cx: &mut Context<Self>) -> Built {
        let stats = Rc::new(Stats {
            data,
            project: self.ctx.project.clone(),
            select: self.ctx.select.clone(),
            open_session: self.ctx.open_session.clone(),
        });
        let view = &stats.data;
        let materials = vec![
            ("types", view.material_types.clone()),
            ("changes", view.materials.clone()),
        ];
        let outcomes = vec![("outcomes", view.execution.outcomes.clone())];
        let duration = vec![("duration", view.execution.duration.clone())];
        Built {
            work: cx.new(|cx| WorkStatistics::new(stats.clone(), cx)),
            activity: cx.new(|_| ActivityStatistics::new(stats.clone())),
            materials: chart(
                &stats,
                "statistics-materials",
                Heading::Materials,
                materials,
                cx,
            ),
            outcomes: chart(
                &stats,
                "statistics-outcomes",
                Heading::Outcomes,
                outcomes,
                cx,
            ),
            duration: chart(
                &stats,
                "statistics-duration",
                Heading::Duration,
                duration,
                cx,
            ),
            stats,
        }
    }

    fn set_period(&mut self, value: &str, cx: &mut Context<Self>) {
        let Some(days) = value.parse().ok().filter(|days| PERIODS.contains(days)) else {
            return;
        };
        if days != self.period {
            self.period = days;
            self.built = None;
            self.load(cx);
        }
    }

    fn header(&self, cx: &mut Context<Self>) -> Stack {
        let words = words(Ds::get(cx).lang());
        let zone = self.built.as_ref().map_or_else(String::new, |built| {
            format!("{} · ", (words.statistics_zone)(&built.stats.data.timezone))
        });
        let control =
            SegmentedControl::new("statistics-period", words.period, self.period.to_string())
                .options(
                    PERIODS
                        .iter()
                        .map(|days| Choice::new(days.to_string(), (words.period_days)(*days))),
                )
                .on_value_change(
                    cx.listener(|this, value: &str, _, cx| this.set_period(value, cx)),
                );
        Stack::new()
            .gap(Space::Sm)
            .child(control)
            .child(Typo::caption(format!("{zone}{}", words.stats.partial_day)))
    }

    /// `ProjectMaterialStatistics`: the chart and what could not be read.
    fn materials(built: &Built, words: &StatWords) -> Stack {
        let data = &built.stats.data;
        let mut stack = Stack::new().gap(Space::Sm).child(built.materials.clone());
        if !data.ledger_history_available {
            stack = stack.child(Typo::caption(words.history_unavailable));
        }
        if !data.session_history_available {
            stack = stack.child(Typo::caption(words.session_unavailable));
        }
        stack
    }

    fn body(built: &Built, cx: &Context<Self>) -> Stack {
        let words = &words(Ds::get(cx).lang()).stats;
        let data = &built.stats.data;
        let mut body = Stack::new()
            .gap(Space::Xl)
            .child(built.work.clone())
            .child(built.activity.clone())
            .child(Self::materials(built, words));
        body = if data.session_history_available {
            let pair = Grid::new("statistics-execution")
                .columns(Columns::Responsive(Responsive {
                    compact: None,
                    base: Preset::Fixed(1),
                    wide: Some(Preset::Fixed(2)),
                }))
                .gap(Space::Xl)
                .page_container()
                .child(built.outcomes.clone())
                .child(built.duration.clone());
            let body = body.child(pair);
            if data.execution.excluded > 0 {
                body.child(Typo::caption((words.excluded)(data.execution.excluded)))
            } else {
                body
            }
        } else {
            body.child(
                Section::new("statistics-outcomes")
                    .title(words.outcomes)
                    .child(Typo::caption(words.session_unavailable)),
            )
        };
        body.child(
            Section::new("statistics-usage").title(words.usage).child(
                Frame::new()
                    .border(Border::Hairline)
                    .radius(Radius::Control)
                    .padding_x(Space::Lg)
                    .padding_y(Space::Md)
                    .child(Typo::caption(words.usage_help)),
            ),
        )
    }
}

impl Render for StatisticsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let all = words(Ds::get(cx).lang());
        let mut stack = Stack::new().gap(Space::Xl).child(self.header(cx));
        if self.error {
            stack = stack.child(
                Notice::new(NoticeTone::Error, all.stats.load_failed).action(
                    Button::new("statistics-retry")
                        .variant(Variant::Outline)
                        .text(all.retry)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.load(cx))),
                ),
            );
        }
        if self.loading {
            let text = if self.built.is_some() {
                all.stats.refreshing.to_owned()
            } else {
                (all.stats.loading)(self.period)
            };
            stack = stack.child(Typo::caption(text));
        }
        if let Some(built) = &self.built {
            stack = stack.child(Self::body(built, cx));
        }
        let content: AnyElement = stack.into_any_element();
        anchor(div().id("dashboard-statistics"), "dashboard-statistics").child(content)
    }
}
