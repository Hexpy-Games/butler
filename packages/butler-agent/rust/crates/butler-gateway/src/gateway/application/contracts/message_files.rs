//! File admission values and the durable file-storage port.
use super::MaterializedResponderFile;
use crate::gateway::{ApplicationFuture, MessageFileRef};
use bytes::Bytes;

pub trait AppMessageFileStorage: Send + Sync + 'static {
    fn replace_browser_still(
        &self,
        file: AppMessageFileSnapshot,
        bytes: Bytes,
        name: String,
    ) -> ApplicationFuture<MaterializedResponderFile>;
    fn write_upload(&self, input: AppFileWrite) -> ApplicationFuture<MaterializedResponderFile>;
    /// The identity is available immediately; `ready` must finish before a row
    /// or transcript reference can be committed.
    fn stage_upload(&self, input: AppFileWrite) -> ApplicationFuture<PendingMessageFile> {
        let written = self.write_upload(input);
        Box::pin(async move {
            Ok(PendingMessageFile {
                file: written.await?,
                ready: Box::pin(async { Ok(()) }),
            })
        })
    }

    fn cleanup_uploads(
        &self,
        _retained: std::collections::HashSet<String>,
    ) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
    fn prepare_uploaded(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<()>;
    fn read_original(&self, file: AppMessageFileSnapshot) -> ApplicationFuture<Bytes>;
}
#[derive(Clone, Debug)]
pub struct AppMessageFileSnapshot {
    pub title: Option<String>,
    pub source_label: Option<String>,
    pub deliverable: bool,
    pub id: String,
    pub owner_session_id: Option<String>,
    pub message_id: Option<String>,
    pub kind: String,
    pub mime_type: String,
    pub safe_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub storage_name: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct AppFileUpload {
    pub browser_tab: Option<String>,
    pub owner_session_id: Option<String>,
    pub name: String,
    pub mime_type: Option<String>,
    pub bytes: Bytes,
}

pub struct PendingMessageFile {
    pub file: MaterializedResponderFile,
    pub ready: ApplicationFuture<()>,
}

#[derive(Clone, Debug)]
pub struct AppFileWrite {
    pub name: String,
    pub mime_type: Option<String>,
    pub bytes: Bytes,
}

pub struct AppFileDownload {
    pub file: MessageFileRef,
    pub bytes: Bytes,
}
