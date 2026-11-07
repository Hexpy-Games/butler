//! `useFileAttachments`, `useComposerFileDrop` and the composer's file entry points: the picker,
//! drops, pasted files and project documents. Every upload runs through `Jobs` and is applied
//! under the epoch it began in, so a chat change drops it.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast;
use gpui::{ClipboardEntry, Context};

use super::Composer;
use super::attachments::documents::{
    DocumentOutcome, add_project_document, document_failed_notice,
};
use super::attachments::{
    PickedFile, UploadOutcome, open_attachment, pick_files, picked_files, refusal_notice,
    upload_files, upload_notices,
};
use super::state::{
    AttachmentPickerFilter, AttachmentPickerKind, ComposerState, FileLike,
    attachment_picker_filter, composer_image_policy, image_refusal, image_refusal_label,
};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::ProjectDashboardDocument;

impl Composer {
    /// `openAttachmentPicker`: the file dialog for `kind`, pictures only when the model takes them.
    pub(super) fn open_picker(&mut self, kind: AttachmentPickerKind, cx: &mut Context<Self>) {
        let policy = composer_image_policy(self.active_model());
        let filter = attachment_picker_filter(kind, &policy);
        let images = matches!(filter, AttachmentPickerFilter::Images { .. });
        let picked = pick_files(images, cx);
        cx.spawn(async move |this, cx| {
            let files = picked.await;
            if !files.is_empty() {
                let _ = this.update(cx, |this, cx| this.add_files(files, cx));
            }
        })
        .detach();
    }

    /// `addFiles`: the image policy first (a refused picture is said so and left out), then the
    /// uploads.
    pub(super) fn add_files(&mut self, files: Vec<PickedFile>, cx: &mut Context<Self>) {
        let lang = Ds::get(cx).lang();
        let policy = composer_image_policy(self.active_model());
        let mut allowed = Vec::new();
        for file in files {
            let like = FileLike {
                name: &file.name,
                mime_type: &file.mime_type,
                size: i64::try_from(file.size).ok(),
            };
            match image_refusal(&like, &policy) {
                Some(refusal) => {
                    toast::show(cx, refusal_notice(image_refusal_label(refusal, lang)));
                }
                None => allowed.push(file),
            }
        }
        if allowed.is_empty() {
            return;
        }
        let (started, epoch) = (self.attachments.started(), self.attachments.epoch());
        let (count, session) = (allowed.len(), self.inputs.session_id.clone());
        ComposerState::update(cx, |state| state.uploading_count += count);
        self.recompute(cx);
        let fetch = Jobs::run(cx, move |client| {
            upload_files(client, session, allowed, epoch, started)
        });
        cx.spawn(async move |this, cx| {
            let outcome = fetch.await;
            let _ = this.update(cx, |this, cx| this.uploaded(count, started, outcome, cx));
        })
        .detach();
    }

    /// The uploads of one batch finished: the files join the draft and the notices show.
    fn uploaded(
        &mut self,
        count: usize,
        started: u64,
        outcome: Option<UploadOutcome>,
        cx: &mut Context<Self>,
    ) {
        if self.attachments.started() != started {
            return;
        }
        ComposerState::update(cx, |state| {
            state.uploading_count = state.uploading_count.saturating_sub(count);
        });
        if let Some(outcome) = outcome {
            for notice in upload_notices(&outcome, cx) {
                toast::show(cx, notice);
            }
            let accepted = self.attachments.accept(started, outcome.accepted);
            ComposerState::update(cx, |state| state.attachments.extend(accepted));
        }
        self.recompute(cx);
        cx.notify();
    }

    /// `addProjectDocument`: a source reference joins the draft, any other document is uploaded.
    pub(super) fn add_document(
        &mut self,
        document: &ProjectDashboardDocument,
        cx: &mut Context<Self>,
    ) {
        let (started, epoch) = (self.attachments.started(), self.attachments.epoch());
        let (document, session) = (document.clone(), self.inputs.session_id.clone());
        ComposerState::update(cx, |state| state.uploading_count += 1);
        self.recompute(cx);
        let fetch = Jobs::run(cx, move |client| {
            add_project_document(client, session, document, None, epoch, started)
        });
        cx.spawn(async move |this, cx| {
            let outcome = fetch.await;
            let _ = this.update(cx, |this, cx| this.document_added(started, outcome, cx));
        })
        .detach();
    }

    fn document_added(
        &mut self,
        started: u64,
        outcome: Option<DocumentOutcome>,
        cx: &mut Context<Self>,
    ) {
        if self.attachments.started() != started {
            return;
        }
        ComposerState::update(cx, |state| {
            state.uploading_count = state.uploading_count.saturating_sub(1);
        });
        match outcome {
            Some(DocumentOutcome::Source(part)) => {
                ComposerState::update(cx, |state| state.append_content_part(part));
            }
            Some(DocumentOutcome::Attached(uploaded)) => {
                let accepted = self.attachments.accept(started, vec![uploaded]);
                ComposerState::update(cx, |state| state.attachments.extend(accepted));
            }
            Some(DocumentOutcome::Failed(name)) => {
                let notice = document_failed_notice(&name, cx);
                toast::show(cx, notice);
            }
            Some(DocumentOutcome::Stale) | None => {}
        }
        self.recompute(cx);
        cx.notify();
    }

    /// `removeAttachment` of a tile.
    pub(super) fn remove_attachment(&mut self, id: &str, cx: &mut Context<Self>) {
        ComposerState::update(cx, |state| state.remove_attachment(id));
        self.attachments.remove(id);
        self.recompute(cx);
        cx.notify();
    }

    /// The tile's open: a picture in the viewer, another file in the browser.
    pub(super) fn open_attached(&mut self, id: &str, cx: &mut Context<Self>) {
        let attachments = ComposerState::read(cx, |state| state.attachments.clone());
        open_attachment(
            &attachments,
            id,
            |file, cx| {
                if let Some(url) = &file.signed_url {
                    cx.open_url(url);
                }
            },
            cx,
        );
    }

    /// Files pasted from the clipboard share the picker's gate; a picture without a path has
    /// nothing to upload from.
    pub(super) fn add_pasted(&mut self, entries: &[ClipboardEntry], cx: &mut Context<Self>) {
        let files: Vec<PickedFile> = entries
            .iter()
            .filter_map(|entry| match entry {
                ClipboardEntry::ExternalPaths(paths) => Some(picked_files(paths.paths())),
                ClipboardEntry::String(_) | ClipboardEntry::Image(_) => None,
            })
            .flatten()
            .collect();
        if !files.is_empty() {
            self.add_files(files, cx);
        }
    }
}
