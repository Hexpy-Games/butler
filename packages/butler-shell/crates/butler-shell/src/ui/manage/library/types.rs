//! 서랍 data (`browser/libraryStore.ts`, `library/libraryApi.ts`, `library/libraryNav.ts`
//! `useLibraryNames`), shared by the main screen, the detail and the dialogs.
#![allow(
    dead_code,
    reason = "seam types: the 서랍 units (M3, M4) read them; the frame names only LibraryNames"
)]
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{Global, SharedString};
use serde::Deserialize;
use serde_json::Value;

use crate::ui::manage::LibraryKind;
use crate::ui::source::wire::{AnswerBlocksView, ArtifactRevision};

/// A saved item's kind (`LibraryKind | "doc"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LibraryItemKind {
    Scrap,
    Document,
    Bookmark,
    Output,
    Doc,
}

/// `PickedElement.rect`
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub(crate) struct LibraryRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// `ElementFileRef` (shared/browser-element.ts): a saved file.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct LibraryFile {
    pub(crate) file_id: String,
    /// "image" | "text" | "generic"
    pub(crate) kind: String,
    pub(crate) mime_type: String,
    pub(crate) safe_name: String,
    pub(crate) size_bytes: i64,
    pub(crate) sha256: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) signed_url: Option<String>,
    pub(crate) created_at: String,
}

/// `ArtifactRevision`: one earlier version of an output.
pub(crate) type LibraryRevision = ArtifactRevision;

/// `ScrapSnapshot`: a scrap's HTML copy of exactly the picked part (only its size is listed).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct ScrapSnapshot {
    #[serde(default)]
    pub(crate) html: Option<String>,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// `ScrapFields`: the structured fields of a scrap saved from an answer.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub(crate) struct ScrapFields {
    pub(crate) title: Option<String>,
    pub(crate) sub: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) value: Option<Value>,
    pub(crate) facts: Option<Vec<String>>,
    pub(crate) text: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) checked: Option<String>,
}

/// `LibraryItem.origin`: where an output came from.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct LibraryOrigin {
    #[serde(default)]
    pub(crate) document: Option<String>,
    pub(crate) session: String,
    pub(crate) message: String,
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) id: Option<String>,
}

/// `LibraryItem`: a saved item (`Partial<PickedElement>` plus the 서랍 fields). `group` is its
/// scrap group or bookmark folder id; `tags` are shared across kinds; `auto_title` is the name it
/// had before a rename.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryItem {
    pub(crate) id: String,
    pub(crate) kind: LibraryItemKind,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) captured_at: String,
    #[serde(default)]
    pub(crate) tab: Option<String>,
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) tag: Option<String>,
    #[serde(default)]
    pub(crate) site: Option<String>,
    #[serde(default)]
    pub(crate) crop: Option<String>,
    #[serde(default)]
    pub(crate) rect: Option<LibraryRect>,
    #[serde(default, rename = "ref")]
    pub(crate) reference: Option<String>,
    #[serde(default)]
    pub(crate) observation: Option<String>,
    #[serde(default)]
    pub(crate) asset: Option<String>,
    #[serde(default, rename = "image_url")]
    pub(crate) image_url: Option<String>,
    /// "user" | "butler"
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) rev: Option<i64>,
    #[serde(default)]
    pub(crate) file: Option<LibraryFile>,
    #[serde(default)]
    pub(crate) output: Option<String>,
    #[serde(default)]
    pub(crate) folder: Option<String>,
    #[serde(default)]
    pub(crate) session: Option<String>,
    #[serde(default)]
    pub(crate) snapshot: Option<ScrapSnapshot>,
    #[serde(default)]
    pub(crate) group: Option<String>,
    #[serde(default)]
    pub(crate) tags: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) auto_title: Option<String>,
    #[serde(default)]
    pub(crate) fields: Option<ScrapFields>,
    #[serde(default)]
    pub(crate) block: Option<AnswerBlocksView>,
    #[serde(default)]
    pub(crate) origin: Option<LibraryOrigin>,
    #[serde(default)]
    pub(crate) revisions: Option<Vec<LibraryRevision>>,
}

/// `GET /library` (a keyset page).
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct LibraryPageData {
    pub(crate) items: Vec<LibraryItem>,
    #[serde(default)]
    pub(crate) next_cursor: Option<String>,
}

/// `LibraryGroup`: a scrap group or bookmark folder with its most recent items.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryGroup {
    pub(crate) id: String,
    pub(crate) kind: LibraryKind,
    pub(crate) name: String,
    pub(crate) position: i64,
    pub(crate) count: i64,
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) recent: Vec<LibraryItem>,
}

/// `LibraryGroups`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct LibraryGroups {
    pub(crate) groups: Vec<LibraryGroup>,
    pub(crate) ungrouped: i64,
    pub(crate) total: i64,
}

/// `TagCount`
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct TagCount {
    pub(crate) name: String,
    pub(crate) count: i64,
}

/// `LibraryFacets.sites` item.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct SiteCount {
    pub(crate) site: String,
    pub(crate) count: i64,
}

/// `LibraryFacets`
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct LibraryFacets {
    pub(crate) total: i64,
    pub(crate) ungrouped: Option<i64>,
    pub(crate) tags: Vec<TagCount>,
    pub(crate) sites: Vec<SiteCount>,
}

/// `useLibraryNames.groups[id]`
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LibraryGroupName {
    pub(crate) name: SharedString,
    pub(crate) kind: LibraryKind,
    pub(crate) position: i64,
}

/// `useLibraryNames`: the names the titlebar shows for the 서랍's nested levels (a group, the item
/// in the detail panel). The main screen fills the groups; `openDetail` sets the item, which the
/// detail panel reads.
#[derive(Default)]
pub(crate) struct LibraryNames {
    pub(crate) groups: HashMap<SharedString, LibraryGroupName>,
    pub(crate) item: Option<Rc<LibraryItem>>,
}

impl Global for LibraryNames {}
