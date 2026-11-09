//! `management/ProjectResultsPanel.tsx`: the results the project's conversations published.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Border, Box as Frame, Radius, Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    ClickEvent, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, Window, div,
};

use super::copy::{Words, words};
use super::docs::{
    from_artifact, loaded_count, remember_count, retry_notice, save_pins, toggled_pins,
};
use super::format;
use crate::ui::manage::dashboard::DashboardCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{DashboardArtifact, DashboardArtifactPage};
use crate::ui::widgets::anchor;

const PAGE: u32 = 8;

/// `ProjectResultsPanel`
pub(crate) struct ResultsPanel {
    ctx: DashboardCtx,
    page: Option<DashboardArtifactPage>,
    error: bool,
    loading: bool,
    /// The first read keeps reading until the rows the panel last showed are back.
    fill: bool,
    request: u64,
}

impl ResultsPanel {
    pub(crate) fn new(ctx: DashboardCtx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut panel = Self {
            ctx,
            page: None,
            error: false,
            loading: false,
            fill: true,
            request: 0,
        };
        panel.load(None, cx);
        panel
    }

    /// One read: the first page, or the page after `cursor`.
    fn load(&mut self, cursor: Option<String>, cx: &mut Context<Self>) {
        self.request += 1;
        let request = self.request;
        self.error = false;
        self.loading = true;
        let append = cursor.is_some();
        let project = self.ctx.project.to_string();
        fetch(
            cx,
            move |client| async move {
                client
                    .get_project_dashboard_artifacts(
                        &project,
                        cursor.as_deref(),
                        Some(PAGE),
                        None,
                        None,
                    )
                    .await
            },
            move |this: &mut Self, result: Result<DashboardArtifactPage, Error>, cx| {
                this.loaded(request, append, result, cx);
            },
        );
    }

    fn loaded(
        &mut self,
        request: u64,
        append: bool,
        result: Result<DashboardArtifactPage, Error>,
        cx: &mut Context<Self>,
    ) {
        if request != self.request {
            return;
        }
        self.loading = false;
        let Ok(mut next) = result else {
            self.error = true;
            return;
        };
        if let (true, Some(old)) = (append, self.page.take()) {
            let mut items = old.items;
            items.append(&mut next.items);
            next.items = items;
        }
        let wanted = loaded_count(cx, &self.ctx.project, "results").unwrap_or(PAGE as usize);
        if self.fill
            && next.items.len() < wanted
            && let Some(cursor) = next.next_cursor.clone()
        {
            self.page = Some(next);
            self.load(Some(cursor), cx);
            return;
        }
        self.fill = false;
        remember_count(cx, &self.ctx.project, "results", next.items.len());
        self.page = Some(next);
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        self.page = None;
        self.fill = true;
        self.load(None, cx);
    }

    fn is_pinned(&self, id: &str) -> bool {
        self.ctx.preferences.as_ref().is_some_and(|preferences| {
            preferences
                .pinned_source_refs
                .iter()
                .any(|pin| pin.kind == "artifact" && pin.id == id)
        })
    }

    fn row(
        &self,
        item: &DashboardArtifact,
        words: &'static Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> NavRow {
        let meta = format!(
            "{} · {}",
            item.session_title,
            format::date(&item.artifact.created_at, lang)
        );
        let ds = Ds::get(cx);
        let (file, chevron) = (
            icon(Icon::FileText, IconSize::Md, ds),
            icon(Icon::ChevronRight, IconSize::Md, ds),
        );
        let mut actions = button::container(Size::Sm);
        // CARVE-OUT(seam): React's "Ask about this" (`useProjectArtifactAttachment`) copies the
        // result with `POST /projects/{id}/dashboard/attachment` and puts it in the dashboard
        // composer; `ManageCtx` has no composer attach for it yet.
        if self.ctx.preferences.is_some() {
            let label = if self.is_pinned(&item.artifact.id) {
                words.unpin
            } else {
                words.pin
            };
            let pinned = item.clone();
            actions = actions.child(
                IconButton::new(
                    SharedString::from(format!("pin-{}", item.artifact.id)),
                    label,
                )
                .glyph(Icon::Pin)
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    cx.stop_propagation();
                    this.toggle_pin(&pinned, window, cx);
                })),
            );
        }
        let select = self.ctx.select.clone();
        let picked = from_artifact(&self.ctx.project, item);
        NavRow::new(SharedString::from(item.artifact.id.clone()), "")
            .label_element(
                Typo::text(item.artifact.title.clone())
                    .line_clamp(2)
                    .wrap(Wrap::Anywhere),
            )
            .icon(file)
            .multiline()
            .meta(Typo::caption(meta).tone(Tone::Secondary))
            .actions(actions.child(chevron))
            .on_click(move |_, window, cx| select(picked.clone(), window, cx))
    }

    /// `togglePin`
    fn toggle_pin(&mut self, item: &DashboardArtifact, window: &Window, cx: &mut Context<Self>) {
        let Some(preferences) = self.ctx.preferences.clone() else {
            return;
        };
        let pins = toggled_pins(&preferences, "artifact", &item.artifact.id, &item.revision);
        save_pins(&self.ctx, &pins, window, cx);
    }

    fn content(&self, words: &'static Words, lang: Lang, cx: &mut Context<Self>) -> Stack {
        let mut stack = Stack::new().gap(Space::Md);
        if self.error {
            stack = stack.child(retry_notice(
                "results-retry",
                words.dashboard_retry,
                words,
                cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx)),
            ));
        }
        let Some(page) = &self.page else {
            return if self.loading {
                stack.child(Typo::body(words.dashboard_loading))
            } else {
                stack
            };
        };
        if page.items.is_empty() {
            stack = stack.child(Typo::body(words.no_results));
        } else {
            let rows = Stack::new().gap(Space::Xs).children(
                page.items
                    .iter()
                    .map(|item| self.row(item, words, lang, cx))
                    .collect::<Vec<_>>(),
            );
            stack = stack.child(
                Frame::new()
                    .border(Border::Hairline)
                    .radius(Radius::Control)
                    .padding(Space::Xs)
                    .child(rows),
            );
        }
        if let Some(cursor) = page.next_cursor.clone() {
            let more = Button::new("results-more")
                .variant(Variant::Borderless)
                .text(words.load_more)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.load(Some(cursor.clone()), cx);
                }));
            stack = stack.child(if self.loading { more.disabled() } else { more });
        }
        stack
    }
}

impl Render for ResultsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let content = self.content(words, lang, cx);
        anchor(div().id("dashboard-results"), "dashboard-results").child(
            Section::new("project-results")
                .title(words.results)
                .child(content),
        )
    }
}
