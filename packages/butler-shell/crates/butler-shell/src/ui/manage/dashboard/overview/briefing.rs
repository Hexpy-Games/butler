//! `ProjectBriefingPanel` and `ProjectSourceLinks`: the briefing's position, or its suggestions,
//! with the source records each one cites.
use std::collections::HashSet;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::card::Card;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::section::Section as UiSection;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    AnyElement, ClickEvent, Context, IntoElement as _, ParentElement as _, Render, SharedString,
    Window, div,
};
use serde_json::json;

use super::super::copy::words;
use super::super::selection::{add_to_composer, document_kind, source_document, type_of_kind};
use super::super::state::{Refresh, Select};
use crate::ui::composer::state::ComposerState;
use crate::ui::manage::ManageCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{
    DashboardBriefingSource, DashboardBriefingView, ProjectDashboardDocument,
};

/// The briefing sections this panel draws (`section`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::ui::manage::dashboard) enum Section {
    Position,
    Suggestions,
}

/// `requestState.status`
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ask {
    Generating,
    Unavailable,
}

pub(in crate::ui::manage::dashboard) struct BriefingPanel {
    section: Section,
    ctx: ManageCtx,
    project: SharedString,
    select: Select,
    updated: Refresh,
    briefing: Option<Rc<DashboardBriefingView>>,
    /// `attempted`: the source revisions already asked for.
    attempted: HashSet<String>,
    request: Option<(String, Ask)>,
    /// The window is active (React skips the automatic request while `document.hidden`).
    active: bool,
    /// The source lists that are open (`ProjectSourceLinks` keeps its own `open`).
    open: HashSet<String>,
}

impl BriefingPanel {
    pub(in crate::ui::manage::dashboard) fn new(
        section: Section,
        ctx: ManageCtx,
        project: SharedString,
        select: Select,
        updated: Refresh,
    ) -> Self {
        Self {
            section,
            ctx,
            project,
            select,
            updated,
            briefing: None,
            attempted: HashSet::new(),
            request: None,
            active: true,
            open: HashSet::new(),
        }
    }

    /// The dashboard's `briefing`. A briefing that is `needed` is asked for once per revision,
    /// by the position panel.
    pub(in crate::ui::manage::dashboard) fn set(
        &mut self,
        briefing: Option<Rc<DashboardBriefingView>>,
        cx: &mut Context<Self>,
    ) {
        if self.briefing == briefing {
            return;
        }
        self.briefing = briefing;
        cx.notify();
        self.ask_if_wanted(cx);
    }

    /// The window came forward or went back: a wanted request waits for the former.
    pub(in crate::ui::manage::dashboard) fn set_active(
        &mut self,
        active: bool,
        cx: &mut Context<Self>,
    ) {
        self.active = active;
        self.ask_if_wanted(cx);
    }

    /// The automatic request: a `needed` revision not yet asked for, while the window is active.
    fn ask_if_wanted(&mut self, cx: &mut Context<Self>) {
        let wanted = self
            .briefing
            .as_deref()
            .is_some_and(|b| b.status == "needed" && !self.attempted.contains(&b.source_revision));
        if self.section == Section::Position && self.active && wanted {
            self.ask(false, cx);
        }
    }

    /// Whether the panel draws anything (React returns null without a briefing).
    pub(in crate::ui::manage::dashboard) fn visible(&self) -> bool {
        let Some(briefing) = self.briefing.as_deref() else {
            return false;
        };
        match self.section {
            Section::Position => true,
            Section::Suggestions => {
                briefing.status == "ready"
                    && briefing
                        .content
                        .as_ref()
                        .is_some_and(|content| !content.suggestions.is_empty())
            }
        }
    }

    /// `request`: POST the briefing for the revision on screen.
    fn ask(&mut self, retry: bool, cx: &mut Context<Self>) {
        let Some(briefing) = self.briefing.as_deref() else {
            return;
        };
        let requested = briefing.source_revision.clone();
        self.attempted.insert(requested.clone());
        self.request = Some((requested.clone(), Ask::Generating));
        cx.notify();
        let project = self.project.to_string();
        let body = json!({ "sourceRevision": requested, "retry": retry });
        fetch(
            cx,
            move |client| async move {
                client
                    .create_project_dashboard_briefing(&project, &body)
                    .await
            },
            move |this: &mut Self, result: Result<DashboardBriefingView, Error>, cx| match result {
                Ok(next) => {
                    let ask = if next.status == "generating" {
                        Ask::Generating
                    } else {
                        Ask::Unavailable
                    };
                    this.request = Some((requested, ask));
                    (this.updated)(cx);
                }
                Err(_) => this.request = Some((requested, Ask::Unavailable)),
            },
        );
    }

    /// The status on screen: a `needed` briefing shows what its own request answered.
    fn status<'a>(&'a self, briefing: &'a DashboardBriefingView) -> &'a str {
        if briefing.status == "needed"
            && let Some((revision, ask)) = &self.request
            && *revision == briefing.source_revision
        {
            return match ask {
                Ask::Generating => "generating",
                Ask::Unavailable => "unavailable",
            };
        }
        &briefing.status
    }

    /// The document a briefing source opens (`documentFor`).
    fn document(&self, item: &DashboardBriefingSource) -> ProjectDashboardDocument {
        source_document(
            &item.id,
            &self.project,
            Some(&item.revision),
            &item.title,
            document_kind(&item.kind),
            type_of_kind(&item.kind),
            "",
        )
    }

    /// `ProjectSourceLinks`
    fn links(
        &self,
        key: &str,
        ids: &[String],
        coverage: bool,
        briefing: &DashboardBriefingView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let copy = words(ds.lang());
        let rows = ids
            .iter()
            .filter_map(|id| briefing.sources.iter().find(|s| &s.source_id == id))
            .map(|item| {
                let select = self.select.clone();
                let document = self.document(item);
                NavRow::new(
                    SharedString::from(format!("briefing-{key}-{}", item.id)),
                    "",
                )
                .label_element(
                    Typo::text(item.title.clone())
                        .line_clamp(2)
                        .wrap(Wrap::Anywhere),
                )
                .icon(icon(Icon::FileText, IconSize::Md, ds))
                .multiline()
                .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
                .on_click(move |_, _, cx| select(document.clone(), cx))
            })
            .collect::<Vec<_>>();
        let mut list = Stack::new().gap(Space::Sm).children(rows);
        if coverage {
            let scope = &briefing.coverage;
            list = list.child(Typo::caption(format!(
                "{} · {}",
                copy.summarized,
                (copy.briefing_coverage)(
                    scope.included_works,
                    scope.total_works,
                    scope.included_documents,
                    scope.included_reports,
                    scope.excluded_units
                )
            )));
        }
        let toggled = key.to_owned();
        DisclosureRow::new(
            SharedString::from(format!("briefing-sources-{key}")),
            (copy.evidence_count)(ids.len()),
        )
        .surface(Surface::Plain)
        .open(self.open.contains(key))
        .on_toggle(cx.listener(move |this, _: &ClickEvent, _, cx| {
            if !this.open.remove(&toggled) {
                this.open.insert(toggled.clone());
            }
            cx.notify();
        }))
        .child(list)
        .into_any_element()
    }

    fn position(&self, briefing: &DashboardBriefingView, cx: &mut Context<Self>) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let status = self.status(briefing);
        let body = match briefing.content.as_ref().filter(|_| status == "ready") {
            Some(content) => Stack::new()
                .gap(Space::Sm)
                .child(Typo::h3(content.position.title.clone()))
                .child(Typo::body(content.position.body.clone()).tone(Tone::Secondary))
                .child(self.links("position", &content.position.source_ids, true, briefing, cx)),
            None => {
                let unavailable = status == "unavailable";
                let message = if unavailable {
                    copy.briefing_unavailable
                } else {
                    copy.briefing_pending
                };
                let mut stack = Stack::new().gap(Space::Sm).child(Typo::body(message));
                if unavailable && !briefing.sources.is_empty() {
                    stack = stack.child(
                        Button::new("briefing-retry")
                            .variant(Variant::Outline)
                            .text(copy.retry)
                            .on_click(
                                cx.listener(|this, _: &ClickEvent, _, cx| this.ask(true, cx)),
                            ),
                    );
                }
                stack
            }
        };
        UiSection::new("briefing-position")
            .title(copy.position)
            .child(body)
            .into_any_element()
    }

    fn suggestions(
        &self,
        briefing: &DashboardBriefingView,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let copy = words(Ds::get(cx).lang());
        let content = briefing.content.as_ref()?;
        let cards = content
            .suggestions
            .iter()
            .take(3)
            .map(|item| {
                let (title, reason) = (item.title.clone(), item.reason.clone());
                let candidate = item.candidate_id.clone();
                let ask = Button::new(SharedString::from(format!("suggestion-ask-{candidate}")))
                    .variant(Variant::Outline)
                    .text(copy.add_to_composer)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.add_suggestion(&candidate, &title, &reason, cx);
                    }));
                Card::new(SharedString::from(format!(
                    "suggestion-{}",
                    item.candidate_id
                )))
                .child(
                    Stack::new()
                        .gap(Space::Md)
                        .child(Typo::body(item.title.clone()))
                        .child(Typo::caption(item.reason.clone()).tone(Tone::Secondary))
                        .child(ask)
                        .child(self.links(
                            &format!("suggestion-{}", item.candidate_id),
                            &item.source_ids,
                            false,
                            briefing,
                            cx,
                        )),
                )
            })
            .collect::<Vec<_>>();
        let grid = Grid::new("briefing-suggestions-grid")
            .columns(Columns::AUTO_FIT)
            .gap(Space::Md)
            .children(cards);
        Some(
            UiSection::new("briefing-suggestions")
                .title(copy.suggestions)
                .child(grid)
                .into_any_element(),
        )
    }

    /// The suggestion's button: its text joins an empty composer and its source joins the draft.
    fn add_suggestion(
        &mut self,
        candidate: &str,
        title: &str,
        reason: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(briefing) = self.briefing.clone() else {
            return;
        };
        let Some(source) = briefing
            .candidates
            .iter()
            .find(|c| c.id == candidate)
            .and_then(|c| briefing.sources.iter().find(|s| s.source_id == c.source_id))
        else {
            return;
        };
        let document = self.document(source);
        let text = format!("{title}\n{reason}\n");
        ComposerState::update(cx, |composer| {
            if composer.text.trim().is_empty() {
                composer.set_text(&text);
            }
        });
        // CARVE-OUT(seam): `Composer::add_document` takes no topic; React passes the
        // suggestion's title as the reference's topic.
        add_to_composer(&self.ctx, &document, cx);
    }
}

impl Render for BriefingPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let Some(briefing) = self.briefing.clone() else {
            return div().into_any_element();
        };
        match self.section {
            Section::Position => self.position(&briefing, cx),
            Section::Suggestions => self
                .suggestions(&briefing, cx)
                .unwrap_or_else(|| div().into_any_element()),
        }
    }
}
