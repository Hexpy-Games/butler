//! Opening a saved item: `library/libraryFiles.ts`, `LibraryFileViewer.tsx`, `libraryNav.ts`
//! `openDetail` and the `source` branch of `browser/LibraryItemCard.tsx` `openLibraryItem`.
use std::rc::Rc;

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{AnyElement, App, Window};

use super::actions::kind_of;
use super::copy::words;
use crate::ui::browser::open_link;
use crate::ui::manage::documents::open_document;
use crate::ui::manage::library::LIBRARY_VIEWER;
use crate::ui::manage::library::types::{LibraryFile, LibraryItem, LibraryItemKind, LibraryNames};
use crate::ui::manage::{LibraryView, ManageCtx, View};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::SessionArtifactSummary;
use crate::ui::viewer::{self, FileViewerEntry};

/// `storedFileArtifactKind`
fn artifact_kind(file: &LibraryFile) -> &'static str {
    match file.kind.as_str() {
        "image" => "image",
        "text" => "document",
        _ => "file",
    }
}

/// The artifact `openLibraryFile` builds from an item's stored file.
fn artifact_of(item: &LibraryItem, file: &LibraryFile) -> SessionArtifactSummary {
    SessionArtifactSummary {
        sha256: None,
        id: item.id.clone(),
        session_id: item.session.clone(),
        project_id: None,
        message_id: None,
        turn_id: None,
        file_id: Some(file.file_id.clone()),
        title: item.title.clone(),
        kind: artifact_kind(file).to_owned(),
        safe_path_label: Some(file.safe_name.clone()),
        url: Some(file.url.clone()),
        signed_url: file.signed_url.clone(),
        size_bytes: Some(file.size_bytes),
        created_at: item.captured_at.clone(),
        open_action: None,
        source_label: item
            .revisions
            .as_ref()
            .and_then(|revisions| revisions.first())
            .and_then(|revision| revision.file.source_label.clone()),
        deliverable: Some(true),
        revisions: item.revisions.clone(),
    }
}

/// `openLibraryArtifact`: the same file renderer, owned by the drawer while it is the current
/// view; elsewhere the file opens in its conversation.
fn open_artifact(ctx: &ManageCtx, artifact: SessionArtifactSummary, cx: &mut App) {
    let entry = FileViewerEntry::Artifact {
        id: artifact.id.clone(),
        artifact: Box::new(artifact),
    };
    if matches!(ctx.view(cx), View::Library(_)) {
        viewer::open(cx, LIBRARY_VIEWER, entry);
        return;
    }
    let FileViewerEntry::Artifact { artifact, .. } = &entry else {
        return;
    };
    if let Some(session) = artifact.session_id.clone() {
        ctx.open_artifact(session.into(), entry, cx);
    }
}

/// `openLibraryFile`
pub(crate) fn open_file(item: &LibraryItem, ctx: &ManageCtx, cx: &mut App) {
    if let Some(file) = &item.file {
        open_artifact(ctx, artifact_of(item, file), cx);
    }
}

/// `LibraryFileViewer`: the viewer pane the 서랍 owns, while it shows files.
pub(crate) fn file_viewer(
    _ctx: &ManageCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    viewer::file_viewer_pane(LIBRARY_VIEWER, window, cx)
}

/// `openDetail`: the item travels with the route; the panel reads it from [`LibraryNames`].
pub(crate) fn open_detail(ctx: &ManageCtx, item: LibraryItem, from: &LibraryView, cx: &mut App) {
    let view = LibraryView {
        section: Some(kind_of(item.kind)),
        group: from.group.clone(),
        item: Some(item.id.clone().into()),
        doc: None,
    };
    cx.default_global::<LibraryNames>().item = Some(Rc::new(item));
    ctx.set_view(View::Library(view), cx);
}

fn is_document(item: &LibraryItem) -> bool {
    matches!(item.kind, LibraryItemKind::Doc | LibraryItemKind::Document)
}

/// `openLibraryItem(item, true)`: the item's source: its chat, its document, or its page.
pub(super) fn open_source(item: &LibraryItem, ctx: &ManageCtx, cx: &mut App) {
    if let (Some(_), Some(origin)) = (&item.block, &item.origin) {
        match &origin.document {
            Some(document) => open_document(ctx, document.clone().into(), cx),
            None => ctx.open_session(origin.session.clone().into(), cx),
        }
        return;
    }
    let goes_to_chat = item.file.is_some() || item.output.is_some() || is_document(item);
    if let Some(session) = item.session.clone().filter(|_| goes_to_chat) {
        ctx.open_session(session.into(), cx);
        return;
    }
    match item.kind {
        LibraryItemKind::Doc => {}
        LibraryItemKind::Document => open_file(item, ctx, cx),
        _ if item.file.is_some() => open_file(item, ctx, cx),
        _ => open_page(item, cx),
    }
}

/// The source page, or an output's page, in the in-app browser.
pub(crate) fn open_page(item: &LibraryItem, cx: &mut App) {
    if let Some(output) = item.output.clone() {
        let read = Jobs::run(cx, move |client| async move {
            client.get_output_view(&output, None).await.ok()
        });
        cx.spawn(async move |cx| {
            let url = read.await.flatten().and_then(|view| {
                view.get("url")
                    .and_then(|url| url.as_str())
                    .map(str::to_owned)
            });
            cx.update(|cx| match url {
                Some(url) => open_link(&url, cx),
                None => browser_failed(cx),
            });
        })
        .detach();
    } else if super::actions::has_web_source(item) {
        open_link(&item.url, cx);
    }
}

fn browser_failed(cx: &mut App) {
    let text = words(Ds::get(cx).lang()).browser_failed;
    toast::show(cx, Toast::error(text));
}
