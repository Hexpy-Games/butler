//! What the browser import routes answer (`signInsApi.ts`: `ImportSource`, `BrowserImportCounts`).
use serde::Deserialize;

/// Import from exported files instead of a detected profile (`FILE_SOURCE`).
pub(super) const FILE: &str = "file";

/// GET /security/browser-import/sources
#[derive(Deserialize)]
pub(super) struct Sources {
    pub(super) sources: Vec<Source>,
}

/// `ImportSource`
#[derive(Clone, Deserialize)]
pub(super) struct Source {
    pub(super) key: String,
    pub(super) browser: String,
    pub(super) name: String,
    pub(super) permission: Option<String>,
}

/// `BrowserImportCounts`
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct Counts {
    pub(super) run_id: String,
    pub(super) bookmarks: u64,
    pub(super) history: Option<u64>,
    pub(super) passwords: u64,
    pub(super) updated: u64,
    pub(super) invalid: Option<u64>,
    pub(super) existing: u64,
    pub(super) needs_csv: Option<bool>,
    pub(super) export_id: Option<String>,
    pub(super) waiting: Option<bool>,
    pub(super) error: Option<String>,
}

impl Counts {
    /// The five numbers of `settings.browserImport.result`.
    pub(super) fn line(&self) -> [u64; 5] {
        [
            self.bookmarks,
            self.history.unwrap_or(0),
            self.passwords,
            self.updated,
            self.invalid.unwrap_or(0),
        ]
    }
}

/// POST /security/browser-import/export
#[derive(Deserialize)]
pub(super) struct Session {
    pub(super) export_id: String,
}

/// POST /security/browser-import/folder
#[derive(Deserialize)]
pub(super) struct Folder {
    #[serde(default)]
    pub(super) selected: bool,
    pub(super) source: Option<String>,
}

/// What an item card brings over.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Bookmarks,
    Passwords,
    History,
}

/// The item kinds a source can bring over: files carry bookmarks and passwords only.
pub(super) fn kinds(source: &str) -> &'static [Kind] {
    if source == FILE {
        &[Kind::Bookmarks, Kind::Passwords]
    } else {
        &[Kind::Bookmarks, Kind::Passwords, Kind::History]
    }
}

/// Where step 3 stands; `Idle` means nothing ran (a picker was cancelled), so the dialog shows
/// step 2 again.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Idle,
    Progress,
    Csv,
    Permission,
    Primary,
    Error,
    Done,
}
