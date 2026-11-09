//! `browser/LibraryItemCard.tsx` `openLibraryItem` and `goesToChat`: what opening a saved item
//! does.
use butler_ds::ui::toast::{self, Toast};
use gpui::{App, SharedString};
use serde_json::json;

use crate::ui::manage::documents::open_document;
use crate::ui::manage::library::LIBRARY_VIEWER;
use crate::ui::manage::library::detail::{open_detail, open_file};
use crate::ui::manage::library::types::{LibraryItem, LibraryItemKind};
use crate::ui::manage::{LibraryKind, LibraryView, ManageCtx, View};
use crate::ui::source::wire::SessionArtifactSummary;
use crate::ui::viewer::{self, FileViewerEntry};

/// `documentKind(item)`: editable documents (`doc`) and stored document files (`document`).
pub(crate) fn is_document(item: &LibraryItem) -> bool {
    matches!(item.kind, LibraryItemKind::Doc | LibraryItemKind::Document)
}

/// `hasWebSource`: a non-empty, absolute HTTP(S) URL.
pub(crate) fn has_web_source(item: &LibraryItem) -> bool {
    url::Url::parse(&item.url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// `goesToChat`: a stored file, page or document from a chat has that chat as its source.
pub(crate) fn goes_to_chat(item: &LibraryItem) -> bool {
    item.session.is_some() && (item.file.is_some() || item.output.is_some() || is_document(item))
}

/// `openLibraryItem`: an item opens in the 서랍's viewer; `source` goes to what it came from.
pub(crate) fn open_library_item(ctx: &ManageCtx, item: &LibraryItem, source: bool, cx: &mut App) {
    if let (Some(_), Some(origin)) = (&item.block, &item.origin) {
        match (&origin.document, source) {
            (Some(document), true) => open_document(ctx, document.clone().into(), cx),
            (None, true) => ctx.open_session(origin.session.clone().into(), cx),
            (_, false) => open_detail(
                ctx,
                item.clone(),
                &LibraryView {
                    section: Some(LibraryKind::Scrap),
                    ..LibraryView::default()
                },
                cx,
            ),
        }
        return;
    }
    if source && goes_to_chat(item) {
        if let Some(session) = &item.session {
            ctx.open_session(session.clone().into(), cx);
        }
        return;
    }
    if is_document(item) {
        match (item.kind, source) {
            (LibraryItemKind::Doc, false) => open_document(ctx, item.id.clone().into(), cx),
            (LibraryItemKind::Document, _) => open_file(item, ctx, cx),
            _ => {}
        }
        return;
    }
    // CARVE-OUT(G-ds): `ScrapViewer` (browser/ScrapViewer.tsx, the scrap's HTML copy in a
    // sandboxed frame) has no unit; the scrap's detail panel shows it instead.
    if !source && item.kind == LibraryItemKind::Scrap && item.snapshot.is_some() {
        open_detail(ctx, item.clone(), &LibraryView::default(), cx);
        return;
    }
    if item.file.is_some() {
        open_file(item, ctx, cx);
        return;
    }
    if let (false, Some(output)) = (source, &item.output) {
        open_output(ctx, item, output, cx);
    }
    // CARVE-OUT(G-cef): a bookmark, a source page or an output's page opens in the in-app
    // browser (`openLink`, `/outputs/{id}/view`); the browser view is P5.
}

/// `openLibraryArtifact` for a page the agent made.
fn open_output(ctx: &ManageCtx, item: &LibraryItem, id: &str, cx: &mut App) {
    let artifact = serde_json::from_value::<SessionArtifactSummary>(json!({
        "id": id,
        "session_id": item.session,
        "kind": "web",
        "title": item.title,
        "created_at": item.captured_at,
    }));
    let Ok(artifact) = artifact else {
        let lang = butler_ds::ui::context::Ds::get(cx).lang();
        toast::show(
            cx,
            Toast::error(crate::ui::i18n::manage::words(lang).browser_failed),
        );
        return;
    };
    let entry = FileViewerEntry::Artifact {
        id: id.to_owned(),
        artifact: Box::new(artifact),
    };
    match (ctx.view(cx), &item.session) {
        (View::Library(_), _) => viewer::open(cx, LIBRARY_VIEWER, entry),
        (_, Some(session)) => ctx.open_artifact(SharedString::from(session.clone()), entry, cx),
        _ => {}
    }
}
