//! `management/ProjectMaterialsPanel.tsx`: the project's documents, the pinned ones first. With a
//! `limit` it is the overview's short list of important materials (`onShowAll`).
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
use super::docs::{loaded_count, remember_count, retry_notice, save_pins, toggled_pins, type_name};
use super::format;
use crate::ui::manage::dashboard::{DashboardCtx, DashboardTab};
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{
    DashboardMaterialsPage, DashboardMaterialsReady, ProjectDashboardDocument,
};
use crate::ui::widgets::anchor;

/// `ProjectMaterialsPanel` (`limit`: the overview's short list).
pub(crate) struct MaterialsPanel {
    ctx: DashboardCtx,
    limit: Option<usize>,
    page: Option<DashboardMaterialsPage>,
    error: bool,
    loading: bool,
    /// The first read keeps reading until the rows the panel last showed are back.
    fill: bool,
    request: u64,
}

impl MaterialsPanel {
    pub(crate) fn new(
        ctx: DashboardCtx,
        limit: Option<usize>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut panel = Self {
            ctx,
            limit,
            page: None,
            error: false,
            loading: false,
            fill: true,
            request: 0,
        };
        panel.load(None, cx);
        panel
    }

    fn size(&self) -> usize {
        self.limit.unwrap_or(8)
    }

    /// One read: the first page, or the page after `cursor`.
    fn load(&mut self, cursor: Option<String>, cx: &mut Context<Self>) {
        self.request += 1;
        let request = self.request;
        self.error = false;
        self.loading = true;
        let append = cursor.is_some();
        let project = self.ctx.project.to_string();
        let size = u32::try_from(self.size()).unwrap_or(8);
        let important = self.limit.is_some();
        fetch(
            cx,
            move |client| async move {
                client
                    .get_project_dashboard_materials(
                        &project,
                        cursor.as_deref(),
                        Some(size),
                        None,
                        important.then_some(true),
                    )
                    .await
            },
            move |this: &mut Self, result: Result<DashboardMaterialsPage, Error>, cx| {
                this.loaded(request, append, result, cx);
            },
        );
    }

    fn loaded(
        &mut self,
        request: u64,
        append: bool,
        result: Result<DashboardMaterialsPage, Error>,
        cx: &mut Context<Self>,
    ) {
        if request != self.request {
            return;
        }
        self.loading = false;
        let Ok(next) = result else {
            self.error = true;
            return;
        };
        self.page = Some(match (append, self.page.take(), next) {
            (
                true,
                Some(DashboardMaterialsPage::Ready(old)),
                DashboardMaterialsPage::Ready(mut next),
            ) => {
                let mut documents = old.documents;
                documents.append(&mut next.documents);
                next.documents = documents;
                DashboardMaterialsPage::Ready(next)
            }
            (_, _, next) => next,
        });
        if let Some(DashboardMaterialsPage::Ready(ready)) = &self.page {
            let wanted = loaded_count(cx, &self.ctx.project, "materials").unwrap_or(self.size());
            let more = ready.next_cursor.clone();
            if self.fill
                && ready.documents.len() < wanted
                && let Some(cursor) = more
            {
                self.load(Some(cursor), cx);
                return;
            }
            if self.limit.is_none() {
                remember_count(cx, &self.ctx.project, "materials", ready.documents.len());
            }
        }
        self.fill = false;
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        self.page = None;
        self.fill = true;
        self.load(None, cx);
    }

    fn is_pinned(&self, document: &ProjectDashboardDocument) -> bool {
        let kind = type_name(document);
        self.ctx.preferences.as_ref().is_some_and(|preferences| {
            preferences
                .pinned_source_refs
                .iter()
                .any(|pin| pin.id == document.id && pin.kind == kind)
        })
    }

    /// `togglePin`
    fn toggle_pin(
        &mut self,
        document: &ProjectDashboardDocument,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(preferences), Some(revision)) =
            (self.ctx.preferences.clone(), document.revision.as_deref())
        else {
            return;
        };
        let pins = toggled_pins(&preferences, type_name(document), &document.id, revision);
        save_pins(&self.ctx, &pins, window, cx);
    }

    fn row(
        &self,
        document: &ProjectDashboardDocument,
        words: &'static Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> NavRow {
        let unavailable = document.unavailable == Some(true);
        let title = if unavailable {
            words.missing_source
        } else {
            document.title.as_str()
        };
        let meta = [
            words.badge(type_name(document)).to_owned(),
            format::date(&document.updated_at, lang),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        let ds = Ds::get(cx);
        let (file, chevron) = (
            icon(Icon::FileText, IconSize::Md, ds),
            icon(Icon::ChevronRight, IconSize::Md, ds),
        );
        let mut actions = button::container(Size::Sm);
        if self.ctx.preferences.is_some() && self.limit.is_none() {
            let label = if self.is_pinned(document) {
                words.unpin
            } else {
                words.pin
            };
            let pinned = document.clone();
            actions = actions.child(
                IconButton::new(SharedString::from(format!("pin-{}", document.id)), label)
                    .glyph(Icon::Pin)
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        cx.stop_propagation();
                        this.toggle_pin(&pinned, window, cx);
                    })),
            );
        }
        let select = self.ctx.select.clone();
        let picked = document.clone();
        let row = NavRow::new(
            SharedString::from(format!("{}:{}", type_name(document), document.id)),
            "",
        )
        .label_element(
            Typo::text(title.to_owned())
                .line_clamp(2)
                .wrap(Wrap::Anywhere),
        )
        .icon(file)
        .multiline()
        .meta(Typo::caption(meta).tone(Tone::Secondary))
        .actions(actions.child(chevron))
        .on_click(move |_, window, cx| select(picked.clone(), window, cx));
        if unavailable { row.disabled() } else { row }
    }

    fn list(
        &self,
        documents: Vec<&ProjectDashboardDocument>,
        words: &'static Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> Frame {
        let rows = Stack::new().gap(Space::Xs).children(
            documents
                .into_iter()
                .map(|document| self.row(document, words, lang, cx))
                .collect::<Vec<_>>(),
        );
        Frame::new()
            .border(Border::Hairline)
            .radius(Radius::Control)
            .padding(Space::Xs)
            .child(rows)
    }

    fn body(
        &self,
        ready: &DashboardMaterialsReady,
        words: &'static Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> Stack {
        let (pinned, others): (Vec<_>, Vec<_>) = ready
            .documents
            .iter()
            .partition(|document| self.is_pinned(document));
        let groups = if self.limit.is_some() {
            vec![("", ready.documents.iter().collect())]
        } else {
            vec![
                (words.important_materials, pinned),
                (words.project_documents, others),
            ]
        };
        let mut stack = Stack::new().gap(Space::Xl);
        for (title, documents) in groups.into_iter().filter(|(_, rows)| !rows.is_empty()) {
            let mut section = Section::new(SharedString::from(format!("materials-{title}")));
            if !title.is_empty() {
                section = section.title(title);
            }
            stack = stack.child(section.child(self.list(documents, words, lang, cx)));
        }
        if ready.documents.is_empty() {
            stack = stack.child(Typo::body(words.no_documents));
        }
        if let Some(cursor) = ready.next_cursor.clone() {
            stack = stack.child(self.more(cursor, words, cx));
        }
        stack
    }

    fn more(&self, cursor: String, words: &'static Words, cx: &mut Context<Self>) -> Button {
        let show_all = self.limit.is_some();
        let set_tab = self.ctx.set_tab.clone();
        let button = Button::new("materials-more")
            .variant(Variant::Borderless)
            .text(words.load_more)
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                if show_all {
                    set_tab(DashboardTab::Materials, window, cx);
                } else {
                    this.load(Some(cursor.clone()), cx);
                }
            }));
        if self.loading {
            button.disabled()
        } else {
            button
        }
    }
}

impl Render for MaterialsPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let body = if self.error {
            retry_notice(
                "materials-retry",
                words.dashboard_retry,
                words,
                cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx)),
            )
            .into_any_element()
        } else {
            match &self.page {
                None => Typo::body(words.dashboard_loading).into_any_element(),
                Some(DashboardMaterialsPage::Unavailable { .. }) => {
                    Typo::body(words.unavailable).into_any_element()
                }
                Some(DashboardMaterialsPage::Ready(ready)) => {
                    self.body(ready, words, lang, cx).into_any_element()
                }
            }
        };
        anchor(div().id("dashboard-materials"), "dashboard-materials").child(body)
    }
}
