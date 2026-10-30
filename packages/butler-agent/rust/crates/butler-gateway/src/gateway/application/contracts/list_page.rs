//! Bounded, live keyset traversal of mutable session ordering.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct AppListPage {
    pub limit: u32,
    pub cursor: AppListCursor,
}

/// Transport encodes this value as an opaque cursor, scoped to list filters.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppListCursor {
    pub pinned: bool,
    pub updated_at: String,
    pub created_at: String,
    pub after: Option<String>,
    pub scope: String,
}
