//! What a list shows (`library/libraryApi.ts` `LibraryQuery`, `queryString`): the kind, a group
//! ("none" is ungrouped) and the filters, all AND.
use butler_shell_client::{Error, ShellClient};
use serde_json::Value;

use super::{Filters, Sort};
use crate::ui::manage::LibraryKind;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Query {
    pub(crate) kind: LibraryKind,
    pub(crate) group: Option<String>,
    pub(crate) q: String,
    pub(crate) tags: Vec<String>,
    pub(crate) site: Option<String>,
    pub(crate) since: Option<String>,
    pub(crate) until: Option<String>,
    pub(crate) sort: Sort,
}

/// The `kind` parameter; documents are `kinds=doc,document`.
pub(crate) fn kind_param(kind: LibraryKind) -> &'static str {
    match kind {
        LibraryKind::Scrap => "scrap",
        LibraryKind::Document => "document",
        LibraryKind::Bookmark => "bookmark",
        LibraryKind::Output => "output",
    }
}

/// `{ kinds: "doc,document" }` for documents, `{ kind }` for the rest.
fn kinds(kind: LibraryKind) -> (Option<&'static str>, Option<&'static str>) {
    if kind == LibraryKind::Document {
        (None, Some("doc,document"))
    } else {
        (Some(kind_param(kind)), None)
    }
}

impl Query {
    pub(crate) fn new(kind: LibraryKind, group: Option<String>, filters: &Filters) -> Self {
        Self {
            kind,
            group,
            q: filters.q.trim().to_owned(),
            tags: filters.tags.clone(),
            site: filters.site.clone(),
            since: filters
                .since
                .clone()
                .or_else(|| filters.date.as_ref().map(|(_, since)| since.clone())),
            until: filters.until.clone(),
            sort: filters.sort,
        }
    }

    /// `GET /library?…` for one keyset page.
    pub(crate) async fn page(
        self,
        cursor: Option<String>,
        client: ShellClient,
    ) -> Result<Value, Error> {
        let (kind, kinds) = kinds(self.kind);
        let tags = (!self.tags.is_empty()).then(|| self.tags.join(","));
        client
            .list_library(
                kind,
                (!self.q.is_empty()).then_some(self.q.as_str()),
                cursor.as_deref(),
                None,
                kinds,
                self.group.as_deref(),
                tags.as_deref(),
                self.site.as_deref(),
                self.since.as_deref(),
                self.until.as_deref(),
                self.sort.param(),
            )
            .await
    }

    /// `GET /library/facets?…`
    pub(crate) async fn facets(
        kind: LibraryKind,
        group: Option<String>,
        client: ShellClient,
    ) -> Result<Value, Error> {
        let (kind, kinds) = kinds(kind);
        client
            .get_library_facets(kind, kinds, group.as_deref())
            .await
    }
}
