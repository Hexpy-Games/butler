//! The approved actions section (`GrantsSection.tsx`, `GrantRow.tsx`, and the section element of
//! `SecurityAuthoritySections.tsx`).
use butler_ds::ui::blocks::card_list::{CardList, CardListItem};
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Styled as _, div,
};

use super::copy::Words;
use super::dates;
use super::grants::{Kind, Row, Scope};
use super::{SecurityAuthority, glyph};
use crate::ui::Icon;
use crate::ui::settings::state::Load;

/// `SEARCH_AFTER`: the search and the filter appear above this many rows.
const SEARCH_AFTER: usize = 8;

/// `sessionDisplayTitle`: the general channel has a localized identity.
fn chat_title<'a>(id: &str, title: &'a str, words: &'a Words) -> &'a str {
    if id == "general" {
        words.general
    } else {
        title
    }
}

/// `where()` of GrantRow: the project, or the chat or chats the approval was given in.
fn place(row: &Row, words: &Words) -> String {
    match row.scope {
        Scope::Always => String::new(),
        Scope::Project => row.project.clone().unwrap_or_default(),
        Scope::Conversation if row.places.len() > 1 => {
            Words::fill(words.conversations, &row.places.len().to_string())
        }
        Scope::Conversation => {
            let (id, title) = row
                .places
                .first()
                .map_or(("", None), |(id, title)| (id.as_str(), title.as_deref()));
            let title = title
                .filter(|title| !title.is_empty())
                .unwrap_or(words.deleted_chat);
            chat_title(id, title, words).to_owned()
        }
    }
}

/// The lower-cased texts the search looks in.
fn searchable(row: &Row, words: &Words) -> Vec<String> {
    let mut texts = vec![row.target.clone(), row.cwd.clone().unwrap_or_default()];
    texts.extend(row.places.iter().map(|(id, title)| {
        chat_title(id, title.as_deref().unwrap_or(words.deleted_chat), words).to_owned()
    }));
    texts.push(row.project.clone().unwrap_or_default());
    texts.push(words.kinds[row.kind.index()].to_owned());
    texts.iter().map(|text| text.to_lowercase()).collect()
}

fn kind_icon(kind: Kind) -> Icon {
    match kind {
        Kind::Command => Icon::Terminal,
        Kind::FileWrite => Icon::PencilLine,
        Kind::Network => Icon::Globe2,
        Kind::Tool => Icon::McpServer,
        Kind::Other => Icon::ShieldCheck,
    }
}

impl SecurityAuthority {
    pub(super) fn grants_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let words = Self::words(cx);
        let state = self.grants.rows.state(std::vec::Vec::is_empty);
        let this = cx.entity();
        let mut section =
            SettingsSection::new("grants", SettingsSectionKind::List, words.grants_title)
                .description(words.grants_description)
                .state(state)
                .empty_message(words.grants_empty)
                .error_message(words.grants_load_failed)
                .on_retry(move |_, _, cx| this.update(cx, |this, cx| this.load_grants(false, cx)));
        if state == SettingsSectionState::Ready {
            section = section.child(self.grants_body(cx));
        }
        section
    }

    fn grants_body(&self, cx: &mut Context<Self>) -> AnyElement {
        let Load::Ready(rows) = &self.grants.rows else {
            return div().into_any_element();
        };
        let words = Self::words(cx);
        let has_filters = rows.len() > SEARCH_AFTER;
        let search = if has_filters {
            self.grants.query.trim().to_lowercase()
        } else {
            String::new()
        };
        let visible = rows.iter().filter(|row| {
            (!has_filters || self.grants.kind.is_none_or(|kind| kind == row.kind))
                && (search.is_empty()
                    || searchable(row, words)
                        .iter()
                        .any(|text| text.contains(&search)))
        });
        let items: Vec<CardListItem> = visible.map(|row| self.grant_item(row, cx)).collect();
        let list = CardList::new("grants-list")
            .flush()
            .empty(EmptyLine::new(words.no_match).into_any_element())
            .children(items);
        Stack::new()
            .gap(Space::Sm)
            .when(has_filters, |stack| {
                stack.child(self.grant_filters(rows, cx))
            })
            .child(list)
            .into_any_element()
    }

    /// The search box and the kind filter (`Inline`).
    fn grant_filters(&self, rows: &[Row], cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let mut kinds: Vec<Kind> = Vec::new();
        for row in rows {
            if !kinds.contains(&row.kind) {
                kinds.push(row.kind);
            }
        }
        let on_query = cx.entity();
        let on_kind = cx.entity();
        let search = Input::new("grants-search")
            .placeholder(words.search)
            .value(self.grants.query.clone())
            .on_change(move |text, _, cx| {
                on_query.update(cx, |this, cx| {
                    text.clone_into(&mut this.grants.query);
                    cx.notify();
                });
            });
        let filter = kinds
            .iter()
            .fold(
                NativeSelect::new("grants-filter")
                    .value(self.grants.kind.map_or("all", Kind::id))
                    .option("all", words.filter_all),
                |select, kind| select.option(kind.id(), words.kinds[kind.index()]),
            )
            .on_change(move |value, _, cx| {
                on_kind.update(cx, |this, cx| {
                    this.grants.kind = Kind::ALL.into_iter().find(|kind| kind.id() == value);
                    cx.notify();
                });
            });
        Stack::row()
            .gap(Space::Md)
            .wrap(true)
            .cross(Cross::Center)
            .child(div().flex_1().min_w_0().child(search))
            .child(div().flex_none().child(filter))
            .into_any_element()
    }

    /// `GrantRow`. CARVE-OUT(G-card): D1's CardListItem description is text, so the target is
    /// its first line and the expand-on-click of the whole target (React `expanded`) is absent.
    fn grant_item(&self, row: &Row, cx: &mut Context<Self>) -> CardListItem {
        let words = Self::words(cx);
        let target = if row.target.is_empty() {
            words.target_unknown
        } else {
            row.target.as_str()
        };
        let preview = target.split('\n').next().unwrap_or_default().to_owned();
        let date = dates::month_day(&row.created_at, words.lang());
        let cwd = row.cwd.as_deref().map(|cwd| Words::fill(words.cwd, cwd));
        let line = [Some(place(row, words)), cwd, Some(date)]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let tone = if row.scope == Scope::Always {
            TagTone::Warning
        } else {
            TagTone::Neutral
        };
        let meta = Stack::row()
            .gap(Space::Xs)
            .cross(Cross::Center)
            .wrap(true)
            .child(
                Tag::new(
                    SharedString::from(format!("grant-scope-{}", row.key)),
                    words.scopes[row.scope.index()],
                )
                .size(TagSize::Sm)
                .tone(tone),
            )
            .child(Typo::caption(line).tone(Tone::Tertiary).truncate());
        let this = cx.entity();
        let key = row.key.clone();
        let revoke = IconButton::new(
            SharedString::from(format!("grant-revoke-{key}")),
            words.revoke,
        )
        .glyph(Icon::Trash2)
        .when(self.grants.busy.contains(&key), IconButton::disabled)
        .on_click(move |_, _, cx| this.update(cx, |this, cx| this.revoke_grant(&key, cx)));
        CardListItem::new(
            SharedString::from(format!("grant-{}", row.key)),
            words.kinds[row.kind.index()],
        )
        .icon(glyph(cx, kind_icon(row.kind), IconSize::Md))
        .description(preview)
        .meta(meta.into_any_element())
        .actions(revoke.into_any_element())
    }
}
