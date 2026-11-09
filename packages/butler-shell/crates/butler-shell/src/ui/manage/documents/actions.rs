//! `DocumentActions.tsx` and `DocumentExportMenu.tsx`: the versions popover, the original-chat
//! button, the export menu, and the same actions in the ⋯ menu.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::overflow_action_menu::OverflowItem;
use butler_ds::ui::blocks::version_history::{Author, VersionHistory, VersionHistoryEntry};
use butler_ds::ui::button::{Button, Size};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::popover::Popover;
use butler_ds::ui::toast::{self, Toast};
use chrono::{DateTime, Utc};
use gpui::Styled as _;
use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};

use super::DocumentPage;
use super::api;
use super::copy::{Words, words};
use super::export;
use crate::ui::i18n::Locale;

/// `relativeAge` of a timestamp; empty when it does not parse.
fn relative_age(at: &str, lang: Lang) -> String {
    let Ok(at) = DateTime::parse_from_rfc3339(at) else {
        return String::new();
    };
    let seconds = (Utc::now() - at.with_timezone(&Utc)).num_seconds().max(0);
    let locale = match lang {
        Lang::Ko => Locale::Ko,
        Lang::En => Locale::En,
    };
    locale.strings().relative_age(seconds)
}

impl DocumentPage {
    /// The Markdown export of the document on show.
    fn export_markdown(&self, cx: &mut App) {
        if let Some(doc) = self.shown() {
            export::markdown(doc, cx);
        }
    }

    /// The inline actions of the title row, and the ⋯ menu's items.
    pub(super) fn actions(
        &self,
        popover: &Popover,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (AnyElement, Vec<OverflowItem>) {
        let words = words(Ds::get(cx).lang());
        let page = cx.entity().downgrade();
        let glyph = |glyph: Icon, cx: &App| icon(glyph, IconSize::Sm, Ds::get(cx));
        let history_icon = glyph(Icon::History, cx);
        let versions = popover.trigger(|toggle| {
            let button = IconButton::new("document-versions-trigger", words.versions)
                .icon(history_icon)
                .on_click(toggle.on_click());
            crate::ui::widgets::anchor(
                div().flex().id("document-versions-button"),
                "document-versions-button",
            )
            .child(button)
            .into_any_element()
        });
        let chat = self.head.as_ref().and_then(|doc| doc.chat_id.clone());
        let mut inline = Stack::row().gap(Space::Xs).wrap(false).child(versions);
        let mut items = vec![
            OverflowItem::new(words.versions)
                .icon(Icon::History)
                .on_select({
                    let page = page.clone();
                    move |_, cx| {
                        let _ = page.update(cx, |this, cx| this.set_history_open(true, cx));
                    }
                }),
        ];
        if let Some(chat) = chat {
            let chat = SharedString::from(chat);
            let open = {
                let (ctx, chat) = (self.ctx.clone(), chat.clone());
                move |cx: &mut App| ctx.open_session(chat.clone(), cx)
            };
            let click = open.clone();
            inline = inline.child(
                IconButton::new("document-original-chat", words.original_chat)
                    .icon(glyph(Icon::MessageSquare, cx))
                    .on_click(move |_, _, cx| click(cx)),
            );
            items.push(
                OverflowItem::new(words.original_chat)
                    .icon(Icon::MessageSquare)
                    .on_select(move |_, cx| open(cx)),
            );
        }
        inline = inline.child(Self::export_menu(words, window, cx));
        items.push(
            OverflowItem::new(words.export_markdown)
                .icon(Icon::Download)
                .on_select({
                    let page = page.clone();
                    move |_, cx| {
                        let _ = page.update(cx, |this, cx| this.export_markdown(cx));
                    }
                }),
        );
        // CARVE-OUT(G-cef): Export as PDF prints a hidden window (`printToPDF`).
        items.push(
            OverflowItem::new(words.export_pdf)
                .icon(Icon::Download)
                .on_select(move |_, cx| {
                    toast::show(cx, Toast::message(words.not_yet));
                }),
        );
        (inline.into_any_element(), items)
    }

    /// `DocumentExportMenu`: Markdown, and PDF (not yet).
    fn export_menu(
        words: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let page = cx.entity().downgrade();
        let download = icon(Icon::Download, IconSize::Sm, Ds::get(cx));
        let menu = DropdownMenu::new("document-export", window, cx);
        let trigger = menu.trigger(|toggle| {
            IconButton::new("document-export-trigger", words.export)
                .icon(download)
                .menu_trigger()
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let markdown = Item::new(words.markdown).on_select(move |_, cx| {
            let _ = page.update(cx, |this, cx| this.export_markdown(cx));
        });
        // CARVE-OUT(G-cef): PDF export prints a hidden window (`printToPDF`).
        let pdf = Item::new(words.pdf)
            .disabled()
            .description([SharedString::from(words.not_yet)]);
        let content = menu.content(
            DropdownMenuContent::new()
                .align(Align::End)
                .child(markdown)
                .child(pdf),
            window,
            cx,
        );
        div()
            .flex()
            .child(trigger)
            .child(content)
            .into_any_element()
    }

    /// The popover's `VersionHistory`: the revisions, the one on show, and Restore while a
    /// revision other than the head is previewed.
    pub(super) fn versions(&self, head_rev: u64, cx: &mut Context<Self>) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let entries = self
            .history
            .iter()
            .map(|row| {
                let (author, label) = match row.author {
                    api::Author::Butler => (Author::Butler, words.butler),
                    api::Author::User => (Author::User, words.me),
                };
                VersionHistoryEntry {
                    id: row.rev.to_string().into(),
                    author,
                    author_label: label.into(),
                    time: relative_age(&row.updated_at, lang).into(),
                    date_time: Some(row.updated_at.clone().into()),
                }
            })
            .collect();
        let selected = self.preview.as_ref().map_or(head_rev, |doc| doc.rev);
        let page = cx.entity().downgrade();
        let mut history =
            VersionHistory::new("document-versions", words.versions, words.current, entries)
                .selected_id(selected.to_string())
                .on_select({
                    let page = page.clone();
                    move |id: SharedString, _, cx| {
                        if let Ok(rev) = id.parse() {
                            let _ = page.update(cx, |this, cx| this.select(rev, cx));
                        }
                    }
                });
        if self.preview.is_some() {
            history = history.action(
                Button::new("document-restore")
                    .size(Size::Sm)
                    .text(words.restore)
                    .on_click(move |_, _, cx| {
                        let _ = page.update(cx, super::DocumentPage::restore_preview);
                    }),
            );
        }
        crate::ui::widgets::anchor(div().id("document-versions").w_full(), "document-versions")
            .child(history)
            .into_any_element()
    }
}
