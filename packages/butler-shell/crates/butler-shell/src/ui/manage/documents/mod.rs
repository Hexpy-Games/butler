//! The document page, read-only in this wave (`documents/DocumentReadingPage.tsx`,
//! `DocumentPage.tsx`, `DocumentSession.ts`, `documentApi.ts`, `app/documentRoute.ts`,
//! `app/documentEvents.ts`). Editing is P4b (CARVE-OUT(G-doc-edit)): DocumentBody,
//! DocumentNodes, DocumentFormat, documentMarkdown, documentMerge and documentTextImport are not
//! ported, so no draft is kept, nothing is saved and `PUT /documents/{id}` is never sent.
mod actions;
mod api;
mod copy;
mod export;
mod read_view;
mod view;

use std::rc::Rc;
use std::time::Duration;

use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Box, Space};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::toast::{self, Action, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Task, WeakEntity, Window,
    div, px,
};
use serde::Deserialize as _;
use serde_json::Value;

use self::api::{Author, Doc, Revision, Update};
use self::copy::words;
use super::library::LIBRARY_VIEWER;
use super::{LibraryKind, LibraryView, ManageCtx, Topic, View};
use crate::ui::source::agent::Jobs;
use crate::ui::source::fetch::{Flight, fetch_if, sleep};
use crate::ui::viewer::{self, FileViewerEntry};

/// How long after the last Butler edit the page stops saying Butler is editing
/// (`DocumentSession.remote`).
const EDITING_LINGER: Duration = Duration::from_millis(1500);

/// `DocumentReadingPage`: the drawer's reading column around a [`DocumentPage`].
pub(crate) fn reading_page(
    ctx: ManageCtx,
    id: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyView {
    let page = cx.new(|cx| DocumentPage::new(ctx, id, None, None, window, cx));
    cx.new(|_| ReadingPage { page }).into()
}

struct ReadingPage {
    page: Entity<DocumentPage>,
}

impl Render for ReadingPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ds = Ds::get(cx);
        // DS: PageContainer width="narrow" (760px) gutter="2xl".
        let body = Box::new()
            .padding_y(Space::Xxl)
            .child(Box::new().padding(Space::Xxl).child(self.page.clone()));
        ScrollArea::new("document-reading-scroll").fill().child(
            crate::ui::widgets::anchor(
                div()
                    .id("document-reading-page")
                    .w_full()
                    .max_w(px(760.))
                    .mx_auto()
                    .px(Space::Xxl.px(ds)),
                "document-reading-page",
            )
            .child(body),
        )
    }
}

/// `DocumentPage` (without `DocumentBody`'s editing): the title row, the status note, the
/// actions and the body of one document, or of the revision picked in the versions list.
pub(crate) struct DocumentPage {
    ctx: ManageCtx,
    id: SharedString,
    /// The host's title-row slots. An element is built once, so they show on the first frame
    /// only; a host that needs them kept builds the page again (see the report).
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
    /// `state.head`: the document as the server holds it.
    head: Option<Doc>,
    failed: bool,
    /// `state.editing`: Butler wrote the document a moment ago.
    editing: bool,
    /// The revision before Butler's first edit of this stretch: what Undo restores.
    undo_rev: Option<u64>,
    finish: Option<Task<()>>,
    /// The live revision last read, and the `document.updated` payload last acted on.
    revision: u64,
    handled: Option<Rc<Value>>,
    flight: Flight,
    /// `preview`: a revision picked in the versions list.
    preview: Option<Doc>,
    preview_request: u64,
    history: Vec<Revision>,
    history_open: bool,
}

impl DocumentPage {
    pub(crate) fn new(
        ctx: ManageCtx,
        id: SharedString,
        leading: Option<AnyElement>,
        trailing: Option<AnyElement>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&ctx.live, |this, _, cx| this.live_moved(cx))
            .detach();
        // `DocumentSession.close`: a stretch of Butler edits that ends with the page offers Undo.
        cx.on_release(|this, cx| {
            if this.editing {
                notify_edited(&this.ctx, &this.id, this.undo_rev, None, cx);
            }
        })
        .detach();
        let live = ctx.live.read(cx);
        let revision = live.revision(&Topic::Document(id.clone()));
        let handled = live.document_update(&id);
        let mut page = Self {
            ctx,
            id,
            leading,
            trailing,
            head: None,
            failed: false,
            editing: false,
            undo_rev: None,
            finish: None,
            revision,
            handled,
            flight: Flight::default(),
            preview: None,
            preview_request: 0,
            history: Vec::new(),
            history_open: false,
        };
        page.reload(cx);
        page
    }

    /// The live topic moved: a `document.updated` (Butler's says so on the page) or a
    /// reconcile; either way the head is read again.
    fn live_moved(&mut self, cx: &mut Context<Self>) {
        let live = self.ctx.live.read(cx);
        let revision = live.revision(&Topic::Document(self.id.clone()));
        if revision == self.revision {
            return;
        }
        self.revision = revision;
        let fresh = live
            .document_update(&self.id)
            .filter(|update| !self.handled.as_ref().is_some_and(|d| Rc::ptr_eq(d, update)));
        if let Some(update) = fresh {
            self.butler_edit(&update, cx);
            self.handled = Some(update);
        }
        self.reload(cx);
    }

    /// `remote`: Butler's write turns the note to "Butler is editing" and keeps Undo ready.
    // ANIM-MIGRATE(the Butler-editing wash over the changed lines fades out when editing ends)
    fn butler_edit(&mut self, update: &Value, cx: &mut Context<Self>) {
        let Ok(update) = Update::deserialize(update) else {
            return;
        };
        if update.author != Author::Butler || self.head.is_none() {
            return;
        }
        if update.rev > 1 {
            self.undo_rev.get_or_insert(update.rev - 1);
        }
        self.editing = true;
        // The chat's running turn (`DocumentPage` `running`) is not in `ManageCtx`: the note
        // goes after the last edit has lingered.
        self.finish = Some(cx.spawn(async move |this, cx| {
            sleep(cx, EDITING_LINGER).await;
            let _ = this.update(cx, DocumentPage::finish_editing);
        }));
        cx.notify();
    }

    /// `finishEditing`
    fn finish_editing(&mut self, cx: &mut Context<Self>) {
        self.finish = None;
        let rev = self.undo_rev.take();
        if self.editing {
            self.editing = false;
            cx.notify();
            notify_edited(&self.ctx, &self.id, rev, Some(cx.entity().downgrade()), cx);
        }
    }

    /// `load` and the reads after a remote update: one at a time, one more if asked meanwhile.
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.flight.begin() {
            self.read(cx);
        }
    }

    fn read(&mut self, cx: &mut Context<Self>) {
        let id = self.id.to_string();
        fetch_if(
            cx,
            move |client| async move { client.get_document(&id).await },
            |this, result: Result<Doc, Error>, cx| {
                let again = this.flight.end();
                let changed = match result {
                    Ok(doc) => this.accept(doc, cx),
                    Err(_) => {
                        failed(cx);
                        !std::mem::replace(&mut this.failed, true)
                    }
                };
                if again {
                    this.read(cx);
                }
                changed
            },
        );
    }

    /// `accept`: the head is now `doc`; true when the page shows something new.
    fn accept(&mut self, doc: Doc, cx: &mut Context<Self>) -> bool {
        let moved = self.head.as_ref().map(|head| head.rev) != Some(doc.rev);
        let recovered = std::mem::take(&mut self.failed);
        let changed = self.head.as_ref() != Some(&doc) || recovered;
        if changed {
            self.head = Some(doc);
        }
        if moved && self.history_open {
            self.load_history(cx);
        }
        changed
    }

    fn load_history(&mut self, cx: &mut Context<Self>) {
        let id = self.id.to_string();
        fetch_if(
            cx,
            move |client| async move { client.list_document_revisions(&id).await },
            |this, result: Result<Vec<Revision>, Error>, cx| match result {
                Ok(rows) => {
                    let changed = this.history != rows;
                    this.history = rows;
                    changed
                }
                Err(_) => {
                    failed(cx);
                    false
                }
            },
        );
    }

    fn set_history_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.history_open = open;
        if open {
            self.load_history(cx);
        }
        cx.notify();
    }

    /// `select`: previews revision `rev`, or the head again.
    fn select(&mut self, rev: u64, cx: &mut Context<Self>) {
        self.preview_request += 1;
        let request = self.preview_request;
        if self.head.as_ref().is_some_and(|head| head.rev == rev) {
            self.preview = None;
            cx.notify();
            return;
        }
        let id = self.id.to_string();
        fetch_if(
            cx,
            move |client| async move { client.get_document_revision(&id, &rev.to_string()).await },
            move |this, result: Result<Doc, Error>, cx| match result {
                Ok(doc) if this.preview_request == request => {
                    this.preview = Some(doc);
                    true
                }
                Ok(_) => false,
                Err(_) => {
                    failed(cx);
                    false
                }
            },
        );
    }

    /// The Restore button: the previewed revision becomes the head.
    fn restore_preview(&mut self, cx: &mut Context<Self>) {
        let Some(preview) = self.preview.take() else {
            return;
        };
        self.preview_request += 1;
        let page = cx.entity().downgrade();
        restore(&self.ctx, &self.id, preview.rev, Some(page), cx);
        self.set_history_open(false, cx);
    }

    /// The document the page shows: the previewed revision, else the head.
    fn shown(&self) -> Option<&Doc> {
        self.preview.as_ref().or(self.head.as_ref())
    }
}

/// `notifyStatus(appCopy.library.failed, { tone: "error" })`
fn failed(cx: &mut App) {
    let text = words(Ds::get(cx).lang()).failed;
    toast::show(cx, Toast::error(text));
}

/// `DocumentSession.restore`: restores `rev`; the page, when it is still there, takes the
/// answer as its head.
fn restore(
    ctx: &ManageCtx,
    id: &SharedString,
    rev: u64,
    page: Option<WeakEntity<DocumentPage>>,
    cx: &mut App,
) {
    let (ctx, wanted) = (ctx.clone(), id.to_string());
    let request = Jobs::run(cx, move |client| api::restore(client, wanted, rev));
    cx.spawn(async move |cx| {
        let doc = request
            .await
            .and_then(Result::ok)
            .and_then(|answer| Doc::deserialize(answer).ok());
        cx.update(|cx| match doc {
            Some(doc) => {
                ctx.live
                    .update(cx, |live, cx| live.bump(Topic::Library, cx));
                if let Some(page) = page.and_then(|page| page.upgrade()) {
                    page.update(cx, |this, cx| {
                        if this.accept(doc, cx) {
                            cx.notify();
                        }
                    });
                }
            }
            None => failed(cx),
        });
    })
    .detach();
}

/// `notifyEdited`: "Butler edited this", with Undo back to the revision before the edits.
fn notify_edited(
    ctx: &ManageCtx,
    id: &SharedString,
    rev: Option<u64>,
    page: Option<WeakEntity<DocumentPage>>,
    cx: &mut App,
) {
    let Some(rev) = rev else {
        return;
    };
    let words = words(Ds::get(cx).lang());
    let (ctx, id) = (ctx.clone(), id.clone());
    let undo = Action::new(words.undo, move |cx| {
        restore(&ctx, &id, rev, page.clone(), cx);
    });
    toast::show(cx, Toast::message(words.edited).action(undo));
}

/// `openDocument` (documentApi.ts:33, documentRoute.ts): in the 서랍's viewer from the 서랍, in
/// its chat's viewer from a conversation, else on the 서랍's document page.
pub(crate) fn open_document(ctx: &ManageCtx, id: SharedString, cx: &mut App) {
    let (ctx, view, wanted) = (ctx.clone(), ctx.view(cx), id.to_string());
    let request = Jobs::run(cx, move |client| async move {
        client.get_document(&wanted).await.ok()
    });
    cx.spawn(async move |cx| {
        let doc = request
            .await
            .flatten()
            .and_then(|answer| Doc::deserialize(answer).ok());
        cx.update(|cx| match doc {
            Some(doc) => open(&ctx, &view, id, doc, cx),
            None => failed(cx),
        });
    })
    .detach();
}

fn open(ctx: &ManageCtx, view: &View, id: SharedString, doc: Doc, cx: &mut App) {
    let entry = FileViewerEntry::Document {
        id: id.to_string(),
        title: doc.title,
    };
    match (view, doc.chat_id.filter(|chat| !chat.is_empty())) {
        (View::Library(_), _) => viewer::open(cx, LIBRARY_VIEWER, entry),
        (View::Session, Some(chat)) => viewer::open(cx, &chat, entry),
        _ => ctx.set_view(
            View::Library(LibraryView {
                section: Some(LibraryKind::Document),
                doc: Some(id),
                ..LibraryView::default()
            }),
            cx,
        ),
    }
}
