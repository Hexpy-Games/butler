//! Turn-scoped attachment prompt projection with bounded blocking reads.

mod clip;
mod project_source;
mod read;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use crate::btcc::{AttachmentKind, AttachmentRef};
use crate::public_text::trim_js_whitespace;

use super::{ContextError, ContextResult};

pub(crate) struct NativeAttachmentContext {
    butler_data: PathBuf,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
}

impl NativeAttachmentContext {
    pub(crate) fn new(butler_data: PathBuf) -> Self {
        Self {
            butler_data,
            permits: Arc::new(Semaphore::new(2)),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
        }
    }

    pub(crate) async fn render(
        &self,
        attachments: &[AttachmentRef],
        title: &str,
    ) -> ContextResult<String> {
        let attachments: Vec<_> = attachments
            .iter()
            .filter(|attachment| !attachment.id.is_empty())
            .take(12)
            .cloned()
            .collect();
        if attachments.is_empty() {
            return Ok(String::new());
        }
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ContextError::new("closed", "Attachment context reader is closing"))?;
        let butler_data = self.butler_data.clone();
        let title = title.to_owned();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock().expect("attachment owner poisoned");
            if *closing {
                return Err(ContextError::new(
                    "closed",
                    "Attachment context reader is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    render_now(&attachments, &butler_data, &title)
                })
                .await
                .map_err(|error| ContextError::new("attachment_join_failed", error.to_string()));
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|_| {
            ContextError::new("attachment_completion_lost", "Attachment context read lost")
        })?
    }

    /// Read only an App-admitted snapshot identity, with the same bounded job
    /// owner and close barrier used for attachment prompt reads.
    pub(crate) async fn read_project_source(
        &self,
        file_id: String,
        size_bytes: u64,
        sha256: String,
    ) -> ContextResult<Vec<u8>> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ContextError::new("closed", "Attachment context reader is closing"))?;
        let data = self.butler_data.clone();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock().expect("attachment owner poisoned");
            if *closing {
                return Err(ContextError::new(
                    "closed",
                    "Attachment context reader is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    project_source::read(&data, &file_id, size_bytes, &sha256)
                })
                .await
                .map_err(|error| ContextError::new("attachment_join_failed", error.to_string()))
                .and_then(|result| result);
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|_| {
            ContextError::new("attachment_completion_lost", "Project source read lost")
        })?
    }

    pub(crate) async fn close(&self) -> ContextResult<()> {
        {
            let mut closing = self.closing.lock().expect("attachment owner poisoned");
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }
}

fn safe_name(attachment: &AttachmentRef, index: usize) -> String {
    attachment
        .file_name
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("attachment-{}", index + 1))
}

fn kind_text(kind: &AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "image",
        AttachmentKind::Audio => "audio",
        AttachmentKind::Video => "video",
        AttachmentKind::Document => "document",
        AttachmentKind::Binary => "binary",
    }
}

fn render_now(attachments: &[AttachmentRef], butler_data: &std::path::Path, title: &str) -> String {
    let mut lines = Vec::with_capacity(1 + attachments.len() * 7);
    lines.push(format!("## {title}"));
    for (index, attachment) in attachments.iter().enumerate() {
        let mime = attachment
            .mime_type
            .as_deref()
            .map(trim_js_whitespace)
            .filter(|mime| !mime.is_empty())
            .unwrap_or("application/octet-stream");
        let size = attachment
            .size_bytes
            .filter(|size| size.is_finite())
            .map(|size| format!("{} bytes", ryu_js::Buffer::new().format_finite(size)))
            .unwrap_or_else(|| "unknown size".into());
        lines.push(format!(
            "- {} ({}, {mime}, {size}, id: {})",
            safe_name(attachment, index),
            kind_text(&attachment.kind),
            attachment.id
        ));
    }
    let mut remaining = 60_000;
    for (index, attachment) in attachments.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let max_chars = 24_000.min(remaining);
        let Some(text) = read::attachment_content(attachment, butler_data, max_chars) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        remaining = remaining.saturating_sub(text.encode_utf16().count());
        lines.extend([
            String::new(),
            format!("### Attachment Content: {}", safe_name(attachment, index)),
            format!("Attachment ID: {}", attachment.id),
            "````text".into(),
            text,
            "````".into(),
        ]);
    }
    lines.join("\n")
}
