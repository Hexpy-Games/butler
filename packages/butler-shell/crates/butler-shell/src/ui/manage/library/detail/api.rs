//! The 서랍 routes the detail, dialogs and drags call (`library/libraryApi.ts`: `send`,
//! `createGroup`, `renameGroup`, `moveGroup`, `deleteGroup`, `patchItems`, `renameTag`,
//! `deleteTag`, `useLibraryGroups`, `useLibraryTags`). Every write that succeeds is
//! `libraryChanged()`.
use butler_shell_client::{Error, ShellClient};
use gpui::{App, Context, SharedString};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::runtime::changed;
use crate::ui::manage::LibraryKind;
use crate::ui::manage::library::types::{
    LibraryGroup, LibraryGroupName, LibraryGroups, LibraryItem, LibraryNames, TagCount,
};
use crate::ui::source::agent::Jobs;
use crate::ui::source::fetch::fetch_if;

/// The kind as the routes name it.
pub(super) fn kind_name(kind: LibraryKind) -> &'static str {
    match kind {
        LibraryKind::Scrap => "scrap",
        LibraryKind::Document => "document",
        LibraryKind::Bookmark => "bookmark",
        LibraryKind::Output => "output",
    }
}

/// One write on the agent worker; `done` runs with the decoded answer, after the 서랍's lists
/// were told to read again.
pub(crate) fn send<T, F, Fut>(
    cx: &mut App,
    call: F,
    done: impl FnOnce(Result<T, Error>, &mut App) + 'static,
) where
    T: DeserializeOwned + 'static,
    F: FnOnce(ShellClient) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, Error>> + Send + 'static,
{
    let request = Jobs::run(cx, call);
    cx.spawn(async move |cx| {
        let result = match request.await {
            Some(Ok(raw)) => serde_json::from_value(raw).map_err(|_| Error::Protocol),
            Some(Err(error)) => Err(error),
            None => Err(Error::Connection),
        };
        cx.update(|cx| {
            if result.is_ok() {
                changed(cx);
            }
            done(result, cx);
        });
    })
    .detach();
}

/// `ItemsPatch`: `group` is `Some(None)` to take the items out of their group.
#[derive(Default)]
#[expect(
    clippy::option_option,
    reason = "`group` has three states: untouched, out of the group, into a group"
)]
pub(super) struct ItemsPatch {
    pub(super) ids: Vec<String>,
    pub(super) group: Option<Option<String>>,
    pub(super) add_tags: Option<Vec<String>>,
    pub(super) remove_tags: Option<Vec<String>>,
    pub(super) title: Option<String>,
}

impl ItemsPatch {
    fn body(self) -> Value {
        let mut body = Map::new();
        body.insert("ids".into(), json!(self.ids));
        if let Some(group) = self.group {
            body.insert("group".into(), json!(group));
        }
        if let Some(tags) = self.add_tags {
            body.insert("addTags".into(), json!(tags));
        }
        if let Some(tags) = self.remove_tags {
            body.insert("removeTags".into(), json!(tags));
        }
        if let Some(title) = self.title {
            body.insert("title".into(), json!(title));
        }
        Value::Object(body)
    }
}

#[derive(Deserialize)]
struct Items {
    items: Vec<LibraryItem>,
}

#[derive(Deserialize)]
struct Tags {
    tags: Vec<TagCount>,
}

/// `patchItems`: the items as the server now has them.
pub(super) fn patch_items(
    cx: &mut App,
    patch: ItemsPatch,
    done: impl FnOnce(Result<Vec<LibraryItem>, Error>, &mut App) + 'static,
) {
    let body = patch.body();
    send(
        cx,
        move |client| async move { client.update_library_items(&body).await },
        move |result: Result<Items, Error>, cx| done(result.map(|items| items.items), cx),
    );
}

/// `createGroup`: the new group is named for the titlebar at once.
pub(super) fn create_group(
    cx: &mut App,
    kind: LibraryKind,
    name: &str,
    done: impl FnOnce(Result<LibraryGroup, Error>, &mut App) + 'static,
) {
    let body = json!({ "kind": kind_name(kind), "name": name });
    send(
        cx,
        move |client| async move { client.create_library_group(&body).await },
        move |result: Result<LibraryGroup, Error>, cx| {
            if let Ok(group) = &result {
                cx.default_global::<LibraryNames>().groups.insert(
                    group.id.clone().into(),
                    LibraryGroupName {
                        name: group.name.clone().into(),
                        kind,
                        position: group.position,
                    },
                );
            }
            done(result, cx);
        },
    );
}

/// `renameGroup`
pub(super) fn rename_group(
    cx: &mut App,
    id: String,
    name: &str,
    done: impl FnOnce(Result<Value, Error>, &mut App) + 'static,
) {
    let body = json!({ "name": name });
    send(
        cx,
        move |client| async move { client.update_library_group(&id, &body).await },
        done,
    );
}

/// `moveGroup`
pub(super) fn move_group(
    cx: &mut App,
    id: String,
    position: i64,
    done: impl FnOnce(Result<Value, Error>, &mut App) + 'static,
) {
    let body = json!({ "position": position });
    send(
        cx,
        move |client| async move { client.update_library_group(&id, &body).await },
        done,
    );
}

/// `deleteGroup`
pub(super) fn delete_group(
    cx: &mut App,
    id: String,
    done: impl FnOnce(Result<Value, Error>, &mut App) + 'static,
) {
    send(
        cx,
        move |client| async move { client.delete_library_group(&id).await },
        done,
    );
}

/// `renameTag`: renaming onto an existing tag merges them.
pub(super) fn rename_tag(
    cx: &mut App,
    from: &str,
    to: &str,
    done: impl FnOnce(Result<Value, Error>, &mut App) + 'static,
) {
    let body = json!({ "from": from, "to": to });
    send(
        cx,
        move |client| async move { client.update_library_tags(&body).await },
        done,
    );
}

/// `deleteTag`
pub(super) fn delete_tag(
    cx: &mut App,
    name: String,
    done: impl FnOnce(Result<Value, Error>, &mut App) + 'static,
) {
    send(
        cx,
        move |client| async move { client.delete_library_tag(&name).await },
        done,
    );
}

/// `deleteLibrary`
pub(crate) fn delete_item(
    cx: &mut App,
    id: String,
    done: impl FnOnce(Result<Value, Error>, &mut App) + 'static,
) {
    send(
        cx,
        move |client| async move { client.delete_library(&id).await },
        done,
    );
}

/// `useLibraryGroups`: the groups of `kind`, also remembered by name for the titlebar and the
/// drops. `done` says whether the page's data changed.
pub(super) fn load_groups<P: 'static>(
    cx: &mut Context<P>,
    kind: LibraryKind,
    done: impl FnOnce(&mut P, Vec<LibraryGroup>, &mut Context<P>) -> bool + 'static,
) {
    let name = kind_name(kind);
    fetch_if(
        cx,
        move |client| async move { client.list_library_groups(Some(name)).await },
        move |page: &mut P, result: Result<LibraryGroups, Error>, cx| {
            let Ok(read) = result else {
                return false;
            };
            let names = cx.default_global::<LibraryNames>();
            names.groups.retain(|_, group| group.kind != kind);
            for group in &read.groups {
                names.groups.insert(
                    SharedString::from(group.id.clone()),
                    LibraryGroupName {
                        name: group.name.clone().into(),
                        kind,
                        position: group.position,
                    },
                );
            }
            done(page, read.groups, cx)
        },
    );
}

/// `useLibraryTags`
pub(super) fn load_tags<P: 'static>(
    cx: &mut Context<P>,
    done: impl FnOnce(&mut P, Vec<TagCount>, &mut Context<P>) -> bool + 'static,
) {
    fetch_if(
        cx,
        |client| async move { client.list_library_tags().await },
        move |page: &mut P, result: Result<Tags, Error>, cx| match result {
            Ok(read) => done(page, read.tags, cx),
            Err(_) => false,
        },
    );
}
