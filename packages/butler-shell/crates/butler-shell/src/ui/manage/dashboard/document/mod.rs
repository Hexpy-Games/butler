//! `ProjectDocumentDialog` and `ProjectDocumentMarkdownContent`: the open project document, read
//! only, with its facts, its source details and the action that references it in a conversation.
mod reader;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::blocks::key_value_row::{KeyValueRow, ValueSize};
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::blocks::surface_panel::{Elevation, SurfacePanel};
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Layout, Size,
};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Cross, Grid, Justify, Space, Stack, WithItem as _};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Window};

use self::reader::{Entry, markdown_view, reader_view};
use super::copy::{Words, words};
use super::state::DashboardPage;
use crate::ui::source::wire::ProjectDashboardDocument;

impl DashboardPage {
    /// The dialog while a document is open; closing clears it.
    pub(super) fn document_dialog(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let document = self.selection.document.clone()?;
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let view = reader_view(&document, copy, lang);
        let page = cx.entity();
        let dialog = {
            let page = page.clone();
            Dialog::new("project-document-dialog", window, cx)
                .open(true)
                .on_open_change(move |open, _, cx| {
                    if !open {
                        page.update(cx, super::state::DashboardPage::close_document);
                    }
                })
        };
        let kind = view
            .facts
            .first()
            .map(|fact| fact.value.clone())
            .unwrap_or_default();
        let header = DialogHeader::new()
            .child(DialogDescription::new(kind))
            .child(DialogTitle::new(document.title.clone()));
        // CARVE-OUT(G-ds): the DS has no DocumentReader block; its header, facts, body, details
        // and footer are composed here on the dialog's scroll-body layout.
        let mut body = Stack::new().gap(Space::Lg);
        body = body.child(facts(&view.facts));
        // CARVE-OUT(seam): React's ArtifactViewer renders an artifact document's file here; the
        // shell's viewer has no entry that draws one inside another surface.
        body = body.child(markdown_content(&view.body, copy));
        if document.truncated == Some(true) {
            let more = Button::new("project-document-more")
                .variant(Variant::Outline)
                .text(copy.load_more);
            body = body.child(if document.nextCursor.is_some() {
                more.on_click(move |_, _, cx| {
                    page.update(cx, super::state::DashboardPage::load_more);
                })
            } else {
                more.disabled()
            });
        }
        body = body.child(self.details(&document, view.details, copy, cx));
        let content = DialogContent::new()
            .size(Size::Xl)
            .layout(Layout::ScrollBody)
            .header(header)
            .child(body)
            .footer(DialogFooter::new().child(Self::footer(&document, copy, cx)));
        Some(dialog.content(content, window, cx))
    }

    /// The reader's footer: the read-only hint and the reference action.
    fn footer(
        document: &ProjectDashboardDocument,
        copy: &'static Words,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let reference = document.clone();
        let action = Button::new("project-document-reference")
            .variant(Variant::Outline)
            .icon_start(icon(Icon::MessageSquarePlus, IconSize::Md, ds))
            .text(copy.reference_action)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.reference_document(&reference, cx);
            }));
        Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Sm)
            .wrap(true)
            .grow()
            .child(Typo::caption(copy.read_only).tone(Tone::Tertiary))
            .child(action)
            .into_any_element()
    }

    /// The source details, open for one document at a time.
    fn details(
        &self,
        document: &ProjectDashboardDocument,
        entries: Vec<Entry>,
        copy: &'static Words,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let open = self.expanded.as_deref() == Some(document.id.as_str());
        let id = document.id.clone();
        let rows = entries
            .into_iter()
            .map(|entry| KeyValueRow::new(entry.label, entry.value).value_size(ValueSize::Caption));
        DisclosureRow::new("project-document-details", copy.source_details)
            .surface(Surface::Plain)
            .open(open)
            .on_toggle(cx.listener(move |this, _, _, cx| {
                this.expanded = if open { None } else { Some(id.clone()) };
                cx.notify();
            }))
            .child(Stack::new().gap(Space::Xs).children(rows))
            .into_any_element()
    }
}

/// The reader's facts: each label over its value.
fn facts(facts: &[reader::Fact]) -> AnyElement {
    let mut rows = Stack::new().gap(Space::Sm);
    for fact in facts {
        rows = rows.child(
            Grid::new(SharedString::from(format!(
                "project-document-fact-{}",
                fact.id
            )))
            .columns(Columns::LABEL_VALUE)
            .gap(Space::Md)
            .child(Typo::caption(fact.label.clone()).tone(Tone::Tertiary))
            .child(
                Typo::body(fact.value.clone())
                    .tone(Tone::Secondary)
                    .wrap(Wrap::Anywhere),
            ),
        );
    }
    rows.into_any_element()
}

/// `ProjectDocumentMarkdownContent`: the frontmatter as a panel of label and value, then the
/// Markdown. (React's `faviconSrc` link icons are the DS block's globe here.)
fn markdown_content(markdown: &str, copy: &Words) -> AnyElement {
    let (body, entries) = markdown_view(markdown, copy);
    let mut stack = Stack::new().gap(Space::Md);
    if !entries.is_empty() {
        let rows = entries.into_iter().map(|entry| {
            Grid::new(SharedString::from(format!(
                "project-document-meta-{}",
                entry.key
            )))
            .columns(Columns::LABEL_VALUE)
            .gap(Space::Sm)
            .child(Typo::caption(entry.label).tone(Tone::Tertiary))
            .child(
                Typo::caption(entry.value)
                    .tone(Tone::Secondary)
                    .wrap(Wrap::Anywhere),
            )
        });
        stack = stack.child(
            SurfacePanel::new()
                .elevation(Elevation::None)
                .child(Stack::new().gap(Space::Xs).children(rows)),
        );
    }
    stack
        .child(MarkdownContent::new("project-document-markdown", body))
        .into_any_element()
}
