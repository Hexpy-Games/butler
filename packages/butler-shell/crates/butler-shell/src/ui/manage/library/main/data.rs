//! The 서랍's reads (`library/libraryApi.ts` `useLibraryRead`, `useLibraryGroups`,
//! `useLibraryFacets`, `useLibraryTags`, `useLibraryItems`): one GET per list, read again when the
//! query changes or Library changes arrive on the live bus; no polling. A newer answer is never
//! replaced by an older one.
use std::cell::RefCell;
use std::rc::Rc;

use butler_shell_client::{Error, ShellClient};
use gpui::{App, Context, SharedString};
use serde::Deserialize;
use serde_json::Value;

use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::filters::query::{Query, kind_param};
use crate::ui::manage::library::types::{
    LibraryFacets, LibraryGroupName, LibraryGroups, LibraryItem, LibraryNames, LibraryPageData,
    TagCount,
};
use crate::ui::manage::{LibraryKind, LibraryView, View};
use crate::ui::source::fetch::fetch_if;

/// `hasGroups`: scraps have groups, bookmarks folders.
pub(crate) fn has_groups(kind: LibraryKind) -> bool {
    matches!(kind, LibraryKind::Scrap | LibraryKind::Bookmark)
}

/// The kinds of the main screen, in order.
pub(crate) const KINDS: [LibraryKind; 4] = [
    LibraryKind::Scrap,
    LibraryKind::Document,
    LibraryKind::Bookmark,
    LibraryKind::Output,
];

/// `GET /library/tags`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct TagList {
    pub(crate) tags: Vec<TagCount>,
}

/// One read: its answer, whether it failed, and which round of reads it belongs to.
pub(crate) struct Read<T> {
    pub(crate) data: Option<T>,
    pub(crate) failed: bool,
    generation: Option<u64>,
    seq: u64,
}

impl<T> Default for Read<T> {
    fn default() -> Self {
        Self {
            data: None,
            failed: false,
            generation: None,
            seq: 0,
        }
    }
}

impl<T> Read<T> {
    /// The read ended, with an answer or without.
    pub(crate) fn settled(&self) -> bool {
        self.data.is_some() || self.failed
    }
}

pub(crate) type Cell<T> = Rc<RefCell<Read<T>>>;

/// The keyset pages of the kind view's query.
#[derive(Default)]
pub(crate) struct List {
    key: Option<Query>,
    generation: u64,
    seq: u64,
    pub(crate) items: Vec<LibraryItem>,
    pub(crate) next: Option<String>,
    pub(crate) loading: bool,
    pub(crate) failed: bool,
}

pub(crate) fn facets_key(kind: LibraryKind, group: Option<&str>) -> String {
    format!("{}:{}", kind_param(kind), group.unwrap_or_default())
}

/// `useLibraryGroups`' effect: the names the titlebar shows for a group.
fn publish_names(kind: LibraryKind, groups: &LibraryGroups, cx: &mut App) {
    let names = cx.default_global::<LibraryNames>();
    names.groups.retain(|_, group| group.kind != kind);
    for group in &groups.groups {
        names.groups.insert(
            SharedString::from(group.id.clone()),
            LibraryGroupName {
                name: group.name.clone().into(),
                kind,
                position: group.position,
            },
        );
    }
    cx.refresh_windows();
}

impl LibraryPage {
    /// The 서랍 level the view is on.
    pub(crate) fn view(&self, cx: &App) -> LibraryView {
        match self.ctx.view(cx) {
            View::Library(view) => view,
            _ => LibraryView::default(),
        }
    }

    /// Reads what the current level shows. `force` reads everything again (a Library change).
    pub(crate) fn refresh(&mut self, force: bool, cx: &mut Context<Self>) {
        if !matches!(self.ctx.view(cx), View::Library(_)) {
            return;
        }
        if force {
            self.generation += 1;
        }
        let view = self.view(cx);
        if view.item.is_none() && view.doc.is_none() {
            self.want_menus(&view, cx);
            match view.section {
                None => self.want_main(cx),
                Some(kind) => self.want_kind(&view, kind, cx),
            }
        }
        let scope = format!("{:?}{:?}{:?}", view.section, view.group, self.filters);
        if scope != self.selection.scope {
            self.selection.scope = scope;
            self.selection.ids.clear();
            self.selection.anchor = None;
        }
        cx.notify();
    }

    /// `LibraryFilterMenus`' facets and tags.
    fn want_menus(&mut self, view: &LibraryView, cx: &mut Context<Self>) {
        match view.section {
            Some(kind) => self.want_facets(kind, view.group.as_ref().map(ToString::to_string), cx),
            None => {
                for kind in KINDS {
                    self.want_facets(kind, None, cx);
                }
            }
        }
        let tags = self.tags.clone();
        self.want(
            &tags,
            |client| async move { client.list_library_tags().await },
            |_, _| {},
            cx,
        );
    }

    /// `MainSection`'s reads for every kind.
    fn want_main(&mut self, cx: &mut Context<Self>) {
        let filtered = self.filters.active();
        for kind in KINDS {
            let grouped = has_groups(kind) && !filtered;
            if grouped {
                self.want_groups(kind, cx);
            }
            self.want_facets(kind, None, cx);
            let query = Query::new(kind, grouped.then(|| "none".to_owned()), &self.filters);
            let cell = self.rows.entry(query.clone()).or_default().clone();
            self.want(&cell, move |client| query.page(None, client), |_, _| {}, cx);
        }
    }

    /// `LibraryKindView`'s reads.
    fn want_kind(&mut self, view: &LibraryView, kind: LibraryKind, cx: &mut Context<Self>) {
        if has_groups(kind) {
            self.want_groups(kind, cx);
        }
        let query = Query::new(
            kind,
            view.group.as_ref().map(ToString::to_string),
            &self.filters,
        );
        let current = self.list.key.as_ref() == Some(&query);
        if current && self.list.generation == self.generation {
            return;
        }
        if !current {
            self.list = List::default();
        }
        self.list.key = Some(query.clone());
        self.list.generation = self.generation;
        self.load_list(query, None, cx);
    }

    fn want_facets(&mut self, kind: LibraryKind, group: Option<String>, cx: &mut Context<Self>) {
        let key = facets_key(kind, group.as_deref());
        let cell: Cell<LibraryFacets> = self.facets.entry(key).or_default().clone();
        self.want(
            &cell,
            move |client| Query::facets(kind, group, client),
            |_, _| {},
            cx,
        );
    }

    fn want_groups(&mut self, kind: LibraryKind, cx: &mut Context<Self>) {
        let cell: Cell<LibraryGroups> = self.groups.entry(kind).or_default().clone();
        let name = kind_param(kind);
        self.want(
            &cell,
            move |client| async move { client.list_library_groups(Some(name)).await },
            move |groups, cx| publish_names(kind, groups, cx),
            cx,
        );
    }

    /// One read into `cell`, unless this round already did it.
    fn want<T, F, Fut>(
        &mut self,
        cell: &Cell<T>,
        call: F,
        then: impl Fn(&T, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) where
        T: serde::de::DeserializeOwned + PartialEq + 'static,
        F: FnOnce(ShellClient) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value, Error>> + Send + 'static,
    {
        let generation = self.generation;
        let seq = {
            let mut read = cell.borrow_mut();
            if read.generation == Some(generation) {
                return;
            }
            read.generation = Some(generation);
            read.failed = false;
            read.seq += 1;
            read.seq
        };
        let cell = cell.clone();
        fetch_if(cx, call, move |_, result: Result<T, Error>, cx| {
            let mut read = cell.borrow_mut();
            if read.seq != seq {
                return false;
            }
            match result {
                Ok(data) => {
                    then(&data, cx);
                    let changed = read.failed || read.data.as_ref() != Some(&data);
                    read.failed = false;
                    read.data = Some(data);
                    changed
                }
                Err(_) => {
                    read.failed = true;
                    true
                }
            }
        });
    }

    /// One keyset page of the kind view; a cursor appends it.
    fn load_list(&mut self, query: Query, cursor: Option<String>, cx: &mut Context<Self>) {
        let append = cursor.is_some();
        self.list.seq += 1;
        let seq = self.list.seq;
        self.list.loading = true;
        self.list.failed = false;
        fetch_if(
            cx,
            move |client| query.page(cursor, client),
            move |page, result: Result<LibraryPageData, Error>, _| {
                if page.list.seq != seq {
                    return false;
                }
                page.list.loading = false;
                match result {
                    Ok(next) => {
                        if append {
                            page.list.items.extend(next.items);
                        } else {
                            page.list.items = next.items;
                        }
                        page.list.next = next.next_cursor;
                    }
                    Err(_) => page.list.failed = true,
                }
                true
            },
        );
    }

    /// `more`: the next page of the kind view.
    pub(crate) fn load_more(&mut self, cx: &mut Context<Self>) {
        let (Some(query), Some(cursor)) = (self.list.key.clone(), self.list.next.clone()) else {
            return;
        };
        if !self.list.loading {
            self.load_list(query, Some(cursor), cx);
            cx.notify();
        }
    }
}
