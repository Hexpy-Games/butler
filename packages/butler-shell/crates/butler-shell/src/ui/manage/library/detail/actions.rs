//! `library/libraryActions.ts`: filing, renaming and tagging items, with the undo toast, and
//! `itemMeta` (with `documentKinds.ts`' document meta).
use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Action, Toast};
use chrono::{DateTime, Local, Utc};
use gpui::{App, SharedString};

use super::api::{ItemsPatch, patch_items};
use super::copy::words;
use crate::ui::i18n::Locale;
use crate::ui::manage::LibraryKind;
use crate::ui::manage::library::types::{LibraryItem, LibraryItemKind, LibraryNames};

fn failed(mixed: bool, cx: &mut App) {
    let copy = words(Ds::get(cx).lang());
    let text = if mixed { copy.mixed_kinds } else { copy.failed };
    toast::show(cx, Toast::error(text));
}

/// The 서랍 kind an item belongs to (`doc` is a document).
pub(super) fn kind_of(kind: LibraryItemKind) -> LibraryKind {
    match kind {
        LibraryItemKind::Scrap => LibraryKind::Scrap,
        LibraryItemKind::Bookmark => LibraryKind::Bookmark,
        LibraryItemKind::Output => LibraryKind::Output,
        LibraryItemKind::Document | LibraryItemKind::Doc => LibraryKind::Document,
    }
}

/// `syncDetail`: the detail panel's item takes the server's copy.
fn sync_detail(items: &[LibraryItem], cx: &mut App) {
    let names = cx.default_global::<LibraryNames>();
    let Some(id) = names.item.as_ref().map(|item| item.id.clone()) else {
        return;
    };
    if let Some(item) = items.iter().find(|item| item.id == id) {
        names.item = Some(Rc::new(item.clone()));
        cx.refresh_windows();
    }
}

/// `fileItems`: puts items into a group (`None`: out of their group), with an undo that
/// restores each item's own group.
pub(crate) fn file_items(items: Vec<LibraryItem>, group: Option<&SharedString>, cx: &mut App) {
    let moving: Vec<LibraryItem> = items
        .into_iter()
        .filter(|item| item.group.as_deref() != group.map(|id| &**id))
        .collect();
    if moving.is_empty() {
        return;
    }
    let target = group
        .and_then(|id| cx.default_global::<LibraryNames>().groups.get(id))
        .map(|target| (target.name.clone(), target.kind));
    if let Some((_, kind)) = &target
        && moving.iter().any(|item| kind_of(item.kind) != *kind)
    {
        failed(true, cx);
        return;
    }
    let patch = ItemsPatch {
        ids: moving.iter().map(|item| item.id.clone()).collect(),
        group: Some(group.map(ToString::to_string)),
        ..ItemsPatch::default()
    };
    patch_items(cx, patch, move |result, cx| match result {
        Err(_) => failed(false, cx),
        Ok(updated) => {
            sync_detail(&updated, cx);
            let Some((name, _)) = target else {
                return;
            };
            let copy = words(Ds::get(cx).lang());
            let count = i64::try_from(moving.len()).unwrap_or(i64::MAX);
            let undo = Action::new(copy.undo, move |cx| undo(moving.clone(), cx));
            toast::show(cx, Toast::message((copy.added)(count, &name)).action(undo));
        }
    });
}

/// `undo`: each item goes back to the group it had.
fn undo(items: Vec<LibraryItem>, cx: &mut App) {
    let mut by_group: HashMap<Option<String>, Vec<String>> = HashMap::new();
    for item in items {
        by_group.entry(item.group).or_default().push(item.id);
    }
    for (group, ids) in by_group {
        let patch = ItemsPatch {
            ids,
            group: Some(group),
            ..ItemsPatch::default()
        };
        patch_items(cx, patch, |result, cx| {
            if result.is_err() {
                failed(false, cx);
            }
        });
    }
}

/// `renameItem`; `finished` runs once the server has answered (the detail panel resets its
/// field then).
pub(super) fn rename(
    item: &LibraryItem,
    title: &str,
    cx: &mut App,
    finished: impl FnOnce(&mut App) + 'static,
) {
    if title == &*item.title {
        finished(cx);
        return;
    }
    let patch = ItemsPatch {
        ids: vec![item.id.clone()],
        title: Some(title.to_owned()),
        ..ItemsPatch::default()
    };
    patch_items(cx, patch, move |result, cx| {
        match result {
            Ok(updated) => sync_detail(&updated, cx),
            Err(_) => failed(false, cx),
        }
        finished(cx);
    });
}

/// `renameItem`
pub(crate) fn rename_item(item: &LibraryItem, title: &str, cx: &mut App) {
    rename(item, title, cx, |_| {});
}

/// `tagItems`
pub(crate) fn tag_items(
    items: &[LibraryItem],
    add: Vec<SharedString>,
    remove: Vec<SharedString>,
    cx: &mut App,
) {
    if add.is_empty() && remove.is_empty() {
        return;
    }
    let strings = |tags: Vec<SharedString>| tags.iter().map(ToString::to_string).collect();
    let patch = ItemsPatch {
        ids: items.iter().map(|item| item.id.clone()).collect(),
        add_tags: Some(strings(add)),
        remove_tags: Some(strings(remove)),
        ..ItemsPatch::default()
    };
    patch_items(cx, patch, |result, cx| match result {
        Ok(updated) => sync_detail(&updated, cx),
        Err(_) => failed(false, cx),
    });
}

/// A picture's size in layout pixels.
#[allow(
    clippy::cast_possible_truncation,
    reason = "a page element's size is far inside f32"
)]
pub(super) fn pixels(width: f64, height: f64) -> (f32, f32) {
    (width as f32, height as f32)
}

/// `hasWebSource`: a non-empty, absolute HTTP(S) URL.
pub(super) fn has_web_source(item: &LibraryItem) -> bool {
    url::Url::parse(&item.url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// `safeHost`
pub(super) fn safe_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            let host = parsed.host_str()?;
            Some(match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            })
        })
        .unwrap_or_else(|| url.to_owned())
}

/// `relativeAge` of a timestamp, empty when it does not parse.
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

/// `toLocaleDateString(lang)`
fn local_date(at: &str, lang: Lang) -> Option<String> {
    let at = DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Local);
    let format = match lang {
        Lang::Ko => "%Y. %-m. %-d.",
        Lang::En => "%-m/%-d/%Y",
    };
    Some(at.format(format).to_string())
}

/// `itemMeta`: one line of meta: source, version (when kept in several), saved date. The
/// version precedes the date so a narrow card truncates the date.
pub(crate) fn item_meta(item: &LibraryItem, lang: Lang) -> String {
    let copy = words(lang);
    if item.kind == LibraryItemKind::Doc {
        let author = copy.authors[usize::from(item.author.as_deref() == Some("butler"))];
        let age = relative_age(
            item.updated_at.as_deref().unwrap_or(&item.captured_at),
            lang,
        );
        return format!("{age} · {author}");
    }
    let host = if has_web_source(item) {
        item.site
            .clone()
            .or_else(|| (item.kind == LibraryItemKind::Bookmark).then(|| safe_host(&item.url)))
    } else {
        None
    };
    let versions = item.revisions.as_ref().map_or(0, Vec::len);
    let version = (versions > 1).then(|| format!("{} {versions}", copy.revision));
    [host, version, local_date(&item.captured_at, lang)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}
