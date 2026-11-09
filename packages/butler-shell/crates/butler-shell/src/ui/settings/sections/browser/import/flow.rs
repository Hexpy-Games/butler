//! The import flow's actions (`useBrowserImport.ts`): every call is an admin route.
use std::time::Duration;

use butler_shell_client::Error;
use gpui::{AsyncApp, Context, PathPromptOptions};
use serde_json::{Value, json};

use super::dialog::ImportDialog;
use super::model::{Counts, FILE, Folder, Session, Sources};
use crate::ui::settings::state::{fetch, fetch_if};
use crate::ui::source::agent::Jobs;

/// `apiErrorCode(e) ?? "import_unreadable"`: the client returns no error codes.
const UNREADABLE: &str = "import_unreadable";

/// `pickImportFile` / `pickBrowserFolder`: a native dialog; `None` when cancelled.
async fn pick(cx: &mut AsyncApp, directories: bool) -> Option<String> {
    let paths = cx.update(|cx| {
        cx.prompt_for_paths(PathPromptOptions {
            files: !directories,
            directories,
            multiple: false,
            prompt: None,
        })
    });
    let path = paths.await.ok()?.ok()??.into_iter().next()?;
    Some(path.to_string_lossy().into_owned())
}

/// `BrowserImportInput`; a file import picks its files first. `None`: a picker was cancelled.
async fn import_input(source: &str, flags: (bool, bool, bool), cx: &mut AsyncApp) -> Option<Value> {
    let (bookmarks, history, passwords) = flags;
    let mut input = json!({
        "source": source,
        "bookmarks": bookmarks,
        "history": source != FILE && history,
        "passwords": passwords,
    });
    if source == FILE {
        if bookmarks {
            input["bookmarks_path"] = pick(cx, false).await?.into();
        }
        if passwords {
            input["passwords_path"] = pick(cx, false).await?.into();
        }
    }
    Some(input)
}

/// The counts of a later step over the run's earlier ones.
fn carry(prior: Option<&Counts>, mut counts: Counts, add_bookmarks: bool) -> Counts {
    let before = prior.cloned().unwrap_or_default();
    counts.history = Some(before.history.unwrap_or(0));
    counts.bookmarks = if add_bookmarks {
        before.bookmarks + counts.bookmarks
    } else {
        before.bookmarks
    };
    counts.existing = before.existing;
    counts
}

impl ImportDialog {
    /// `useBrowserSources.reload`
    pub(super) fn load_sources(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_browser_import_sources().await },
            |this: &mut Self, result: Result<Sources, Error>, _| match result {
                Ok(list) => this.sources = Some(list.sources),
                Err(_) => {
                    this.sources = Some(Vec::new());
                    this.error = Some(UNREADABLE.into());
                }
            },
        );
    }

    /// The export started for an unfinished run is cancelled when the dialog goes.
    pub(super) fn release(&mut self, cx: &mut gpui::App) {
        if let Some(id) = self.export_id.take() {
            drop(Jobs::run(cx, move |client| async move {
                let body = json!({ "export_id": id });
                client.cancel_browser_password_export(&body).await
            }));
        }
    }

    /// `run`
    pub(super) fn run(&mut self, source: String, cx: &mut Context<Self>) {
        if self.busy || self.export_id.is_some() {
            return;
        }
        self.selected.clone_from(&source);
        self.busy = true;
        self.error = None;
        cx.notify();
        let flags = (
            self.kinds.bookmarks,
            self.kinds.history,
            self.kinds.passwords,
        );
        cx.spawn(async move |this, cx| {
            let input = import_input(&source, flags, cx).await;
            let _ = this.update(cx, |this, cx| match input {
                Some(input) => Self::start(source, input, cx),
                None => {
                    this.busy = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn start(source: String, input: Value, cx: &mut Context<Self>) {
        fetch(
            cx,
            move |client| async move { client.start_browser_import(&input).await },
            move |this: &mut Self, result: Result<Counts, Error>, cx| match result {
                Ok(counts) => {
                    this.error.clone_from(&counts.error);
                    let watch = counts.needs_csv == Some(true) && counts.error.is_none();
                    let run_id = counts.run_id.clone();
                    this.result = Some(counts);
                    (this.on_imported)(cx);
                    if watch {
                        Self::begin_export(source, run_id, cx);
                    } else {
                        this.busy = false;
                    }
                }
                Err(_) => {
                    this.error = Some(UNREADABLE.into());
                    this.busy = false;
                }
            },
        );
    }

    /// `watch`: waits for the owner's CSV export of the browser's passwords.
    fn begin_export(source: String, run_id: String, cx: &mut Context<Self>) {
        fetch(
            cx,
            move |client| async move {
                let body = json!({ "source": source, "run_id": run_id });
                client.begin_browser_password_export(&body).await
            },
            |this: &mut Self, result: Result<Session, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(session) => {
                        this.export_id = Some(session.export_id.clone());
                        Self::poll(session.export_id, cx);
                    }
                    Err(_) => this.error = Some(UNREADABLE.into()),
                }
            },
        );
    }

    /// `usePasswordExportPolling`: once a second until the CSV is in.
    fn poll(id: String, cx: &mut Context<Self>) {
        let body = json!({ "export_id": id });
        fetch_if(
            cx,
            move |client| async move { client.poll_browser_password_export(&body).await },
            move |this: &mut Self, result: Result<Counts, Error>, cx| {
                if this.export_id.as_deref() != Some(id.as_str()) {
                    return false;
                }
                match result {
                    Ok(counts) if counts.waiting == Some(true) => {
                        Self::poll_later(id, cx);
                        return false;
                    }
                    Ok(counts) => {
                        let error = counts.error.clone();
                        this.result = Some(carry(this.result.as_ref(), counts, true));
                        this.export_id = None;
                        this.error = error;
                        (this.on_imported)(cx);
                    }
                    Err(_) => {
                        this.error = Some(UNREADABLE.into());
                        this.export_id = None;
                    }
                }
                true
            },
        );
    }

    fn poll_later(id: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            butler_ds::ui::motion::sleep(cx.background_executor(), Duration::from_secs(1)).await;
            let _ = this.update(cx, |this, cx| {
                if this.export_id.as_deref() == Some(id.as_str()) {
                    Self::poll(id, cx);
                }
            });
        })
        .detach();
    }

    /// `cancel`
    pub(super) fn cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.export_id.take() {
            fetch(
                cx,
                move |client| async move {
                    let body = json!({ "export_id": id });
                    client.cancel_browser_password_export(&body).await
                },
                |_: &mut Self, _: Result<Value, Error>, _| {},
            );
        }
        cx.notify();
    }

    /// `more`
    pub(super) fn more(&mut self, cx: &mut Context<Self>) {
        self.cancel(cx);
        self.result = None;
        self.error = None;
        self.step = 0;
    }

    /// `selectCsv`: the owner picks the exported file by hand.
    pub(super) fn select_csv(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.export_id.clone() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let Some(path) = pick(cx, false).await else {
                return;
            };
            let _ = this.update(cx, |this, cx| this.choose_csv(id, path, cx));
        })
        .detach();
    }

    fn choose_csv(&mut self, id: String, path: String, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                let body = json!({ "export_id": id, "path": path });
                client.choose_browser_password_export(&body).await
            },
            |this: &mut Self, result: Result<Counts, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(counts) => {
                        this.export_id = None;
                        this.result = Some(carry(this.result.as_ref(), counts, false));
                        (this.on_imported)(cx);
                    }
                    Err(_) => this.error = Some(UNREADABLE.into()),
                }
            },
        );
    }

    /// `resumeExport`
    pub(super) fn resume_export(&mut self, cx: &mut Context<Self>) {
        let Some(run_id) = self.result.as_ref().map(|result| result.run_id.clone()) else {
            return;
        };
        self.busy = true;
        self.error = None;
        cx.notify();
        let source = self.selected.clone();
        Self::begin_export(source, run_id, cx);
    }

    /// `removeCsv`
    pub(super) fn remove_csv(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .result
            .as_ref()
            .and_then(|result| result.export_id.clone())
        else {
            return;
        };
        self.busy = true;
        self.error = None;
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                let body = json!({ "export_id": id });
                client.delete_browser_password_export(&body).await
            },
            |this: &mut Self, result: Result<Value, Error>, _| {
                this.busy = false;
                match result {
                    Ok(_) => {
                        if let Some(result) = this.result.as_mut() {
                            result.export_id = None;
                        }
                    }
                    Err(_) => this.error = Some(UNREADABLE.into()),
                }
            },
        );
    }

    /// `folder`: the owner picks the browser's profile folder, then the import runs again.
    pub(super) fn folder(&mut self, cx: &mut Context<Self>) {
        let source = self.selected.clone();
        self.busy = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let path = pick(cx, true).await;
            let _ = this.update(cx, |this, cx| match path {
                Some(path) => Self::choose_folder(source, &path, cx),
                None => {
                    this.busy = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn choose_folder(source: String, path: &str, cx: &mut Context<Self>) {
        let body = json!({ "source": source, "path": path });
        fetch(
            cx,
            move |client| async move { client.pick_browser_import_folder(&body).await },
            move |this: &mut Self, result: Result<Folder, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(Folder {
                        selected: true,
                        source: picked,
                    }) => {
                        Self::load_sources(cx);
                        this.run(picked.unwrap_or(source), cx);
                    }
                    Ok(_) => {}
                    Err(_) => this.error = Some(UNREADABLE.into()),
                }
            },
        );
    }

    /// `openImportDiskAccess`
    pub(super) fn open_disk_access(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        cx.notify();
        fetch(
            cx,
            |client| async move { client.open_browser_import_disk_access(&json!({})).await },
            |this: &mut Self, result: Result<Value, Error>, _| {
                this.busy = false;
                match result {
                    Ok(_) => this.disk_hint = true,
                    Err(_) => this.error = Some(UNREADABLE.into()),
                }
            },
        );
    }
}
