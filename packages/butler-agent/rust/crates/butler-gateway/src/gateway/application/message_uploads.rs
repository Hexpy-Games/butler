//! In-flight uploads are process-local; rows become readable only after durability.
use super::*;
use crate::gateway::MessageFileRef;
use parking_lot::Mutex;
use std::collections::HashMap;
use tokio::sync::watch;
use tokio_util::task::TaskTracker;

#[derive(Default)]
struct State {
    closed: bool,
    pending: HashMap<String, watch::Receiver<bool>>,
}
#[derive(Default)]
pub(super) struct Uploads {
    state: Arc<Mutex<State>>,
    jobs: TaskTracker,
}
impl Uploads {
    fn register(
        &self,
        id: String,
        work: ApplicationFuture<()>,
    ) -> Result<(), GatewayApplicationError> {
        let mut state = self.state.lock();
        if state.closed {
            return Err(GatewayApplicationError::internal());
        }
        let (done, receive) = watch::channel(false);
        state.pending.insert(id.clone(), receive);
        let state = self.state.clone();
        self.jobs.spawn(async move {
            let _ = work.await;
            // Both success and failure release waiters. Row lookup retains the
            // authority to report success, and a failed write never has a row.
            done.send_replace(true);
            state.lock().pending.remove(&id);
        });
        Ok(())
    }
    pub(super) async fn wait(&self, id: &str) -> Result<(), GatewayApplicationError> {
        let receive = self.state.lock().pending.get(id).cloned();
        if let Some(mut receive) = receive {
            receive
                .wait_for(|done| *done)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        Ok(())
    }
    pub(super) async fn close(&self) {
        {
            self.state.lock().closed = true;
            self.jobs.close();
        }
        self.jobs.wait().await;
    }
}

impl AppApplication {
    pub(super) async fn cleanup_uploads(&self) -> Result<(), GatewayApplicationError> {
        let retained = self
            .storage
            .read(|db| {
                let mut query = db
                    .prepare("SELECT id FROM message_files")
                    .map_err(AppStorageError::sqlite)?;
                query
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(AppStorageError::sqlite)?
                    .collect::<Result<std::collections::HashSet<_>, _>>()
                    .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        self.dependencies
            .message_files
            .cleanup_uploads(retained)
            .await
    }

    pub(super) async fn stage_message_file(
        &self,
        input: AppFileUpload,
    ) -> Result<MessageFileRef, GatewayApplicationError> {
        if input.browser_tab.is_some() {
            return self.upload_message_file(input).await;
        }
        let owner = input
            .owner_session_id
            .as_deref()
            .map(butler_core::public_text::trim_js_whitespace)
            .filter(|owner| !owner.is_empty())
            .map(str::to_owned);
        if let Some(owner) = owner.clone() {
            self.storage
                .read(move |db| super::message_files::ensure_chat(db, &owner))
                .await
                .map_err(app_error)?;
        }
        let staged = self
            .dependencies
            .message_files
            .stage_upload(AppFileWrite {
                name: input.name,
                mime_type: input.mime_type,
                bytes: input.bytes,
            })
            .await?;
        let row = snapshot(&staged.file, owner.clone());
        let reference = read_model::message_file_ref(&row).map_err(app_error)?;
        let storage = self.storage.clone();
        let files = self.dependencies.message_files.clone();
        self.uploads.register(
            staged.file.id.clone(),
            Box::pin(async move {
                staged.ready.await?;
                files.prepare_uploaded(row).await?;
                storage
                    .execute(move |db| {
                        super::message_files::insert_uploaded(db, owner.as_ref(), &staged.file)
                    })
                    .await
                    .map_err(app_error)?;
                Ok(())
            }),
        )?;
        Ok(reference)
    }
}

fn snapshot(
    file: &MaterializedResponderFile,
    owner_session_id: Option<String>,
) -> AppMessageFileSnapshot {
    AppMessageFileSnapshot {
        title: file.title.clone(),
        source_label: file.source_label.clone(),
        deliverable: file.deliverable,
        id: file.id.clone(),
        owner_session_id,
        message_id: None,
        kind: file.kind.clone(),
        mime_type: file.mime_type.clone(),
        safe_name: file.safe_name.clone(),
        size_bytes: file.size_bytes,
        sha256: file.sha256.clone(),
        storage_name: file.storage_name.clone(),
        created_at: file.created_at.clone(),
    }
}
