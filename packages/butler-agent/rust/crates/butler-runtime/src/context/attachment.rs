//! Turn-scoped attachment prompt projection with bounded blocking reads.

mod clip;
mod project_source;
mod read;

use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use butler_models::models::{NotInlined, display_name, listing_line, not_inlined_block};
use butler_turn::btcc::{AttachmentKind, AttachmentRef};

use super::{ContextError, ContextResult};
use crate::context::ContextCode;

pub struct AttachmentContext {
    butler_data: PathBuf,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
}

impl AttachmentContext {
    pub fn new(butler_data: PathBuf) -> Self {
        Self {
            butler_data,
            permits: Arc::new(Semaphore::new(2)),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
        }
    }

    pub async fn render(
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
            .map_err(|source| {
                ContextError::new(ContextCode::Closed, "Attachment context reader is closing")
                    .with_source(source)
            })?;
        let butler_data = self.butler_data.clone();
        let title = title.to_owned();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock();
            if *closing {
                return Err(ContextError::new(
                    ContextCode::Closed,
                    "Attachment context reader is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    render_now(&attachments, &butler_data, &title)
                })
                .await
                .map_err(|error| {
                    ContextError::new(ContextCode::AttachmentJoinFailed, error.to_string())
                        .with_source(error)
                });
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|source| {
            ContextError::new(
                ContextCode::AttachmentCompletionLost,
                "Attachment context read lost",
            )
            .with_source(source)
        })?
    }

    /// Read only an App-admitted snapshot identity, with the same bounded job
    /// owner and close barrier used for attachment prompt reads.
    pub async fn read_project_source(
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
            .map_err(|source| {
                ContextError::new(ContextCode::Closed, "Attachment context reader is closing")
                    .with_source(source)
            })?;
        let data = self.butler_data.clone();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock();
            if *closing {
                return Err(ContextError::new(
                    ContextCode::Closed,
                    "Attachment context reader is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    project_source::read(&data, &file_id, size_bytes, &sha256)
                })
                .await
                .map_err(|error| {
                    ContextError::new(ContextCode::AttachmentJoinFailed, error.to_string())
                        .with_source(error)
                })
                .and_then(|result| result);
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|source| {
            ContextError::new(
                ContextCode::AttachmentCompletionLost,
                "Project source read lost",
            )
            .with_source(source)
        })?
    }

    pub async fn close(&self) -> ContextResult<()> {
        {
            let mut closing = self.closing.lock();
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }
}

fn render_now(attachments: &[AttachmentRef], butler_data: &std::path::Path, title: &str) -> String {
    let mut lines = vec![format!("## {title}")];
    for (index, a) in attachments.iter().enumerate() {
        let path = read::attachment_file_path(a, butler_data);
        lines.push(listing_line(a, index, path.as_deref()));
    }
    let mut remaining = 60_000usize;
    for (index, a) in attachments.iter().enumerate() {
        if a.kind == AttachmentKind::Image {
            continue;
        }
        let content = if remaining == 0 {
            read::Content::NotInlined(NotInlined::Budget)
        } else {
            read::attachment_content(a, butler_data, 24_000.min(remaining))
        };
        match content {
            read::Content::Inline(text) => {
                remaining = remaining.saturating_sub(text.encode_utf16().count());
                lines.extend([
                    String::new(),
                    format!("### Attachment Content: {}", display_name(a, index)),
                    format!("Attachment ID: {}", a.id),
                    "````text".into(),
                    text,
                    "````".into(),
                ]);
            }
            read::Content::NotInlined(reason) => {
                let path = read::attachment_file_path(a, butler_data);
                lines.extend([
                    String::new(),
                    not_inlined_block(a, index, path.as_deref(), reason),
                ]);
            }
            read::Content::Skip => {}
        }
    }
    lines.join("\n")
}
