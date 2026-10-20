//! A bounded, change-driven file lane; completion follows the shared directory flush.
use super::*;
use std::collections::VecDeque;

struct Job {
    file: MaterializedResponderFile,
    bytes: Bytes,
    done: oneshot::Sender<Result<(), GatewayApplicationError>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
#[derive(Default)]
struct State {
    pending: VecDeque<Job>,
    running: bool,
}
pub(super) struct Lane {
    state: Arc<Mutex<State>>,
    permits: Arc<Semaphore>,
}
impl Default for Lane {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            permits: Arc::new(Semaphore::new(16)),
        }
    }
}
impl Lane {
    pub(super) fn close(&self) {
        self.permits.close();
    }

    pub(super) fn enqueue(
        &self,
        owner: &AppMessageFiles,
        admission: ApplicationFuture<(MaterializedResponderFile, Bytes)>,
    ) -> ApplicationFuture<super::super::PendingMessageFile> {
        let permits = self.permits.clone();
        let state = self.state.clone();
        let root = owner.root.clone();
        let closing = owner.closing.clone();
        let jobs = owner.jobs.clone();
        Box::pin(async move {
            let permit = permits
                .acquire_owned()
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            let (file, bytes) = admission.await?;
            let (done, receive) = oneshot::channel();
            {
                let closing = closing.lock();
                if *closing {
                    return Err(GatewayApplicationError::internal());
                }
                let mut queue = state.lock();
                queue.pending.push_back(Job {
                    file: file.clone(),
                    bytes,
                    done,
                    _permit: permit,
                });
                if !queue.running {
                    queue.running = true;
                    let state = state.clone();
                    jobs.spawn_blocking(move || drain(&root, &state));
                }
            }
            Ok(super::super::PendingMessageFile {
                file,
                ready: Box::pin(async move {
                    receive
                        .await
                        .map_err(GatewayApplicationError::internal_from)?
                }),
            })
        })
    }
}

fn drain(root: &Path, state: &Mutex<State>) {
    loop {
        let first = {
            let mut state = state.lock();
            match state.pending.pop_front() {
                Some(job) => job,
                None => {
                    state.running = false;
                    return;
                }
            }
        };
        commit(root, first, state);
    }
}

fn commit(root: &Path, first: Job, state: &Mutex<State>) {
    let mut batch = butler_platform::secure_fs::PrivateFileBatch::new(root);
    let mut completed = Vec::new();
    let directory = std::fs::create_dir_all(root);
    let mut next = Some(first);
    let mut count = 0;
    while let Some(job) = next {
        count += 1;
        let result = directory
            .as_ref()
            .map_err(|_| GatewayApplicationError::internal())
            .and_then(|()| {
                batch
                    .write(&root.join(&job.file.storage_name), |file| {
                        butler_platform::secure_fs::fault_write(file, &job.bytes, "message_upload")
                    })
                    .map_err(GatewayApplicationError::internal_from)
            });
        if let Err(error) = result {
            let _ = job.done.send(Err(error));
        } else {
            completed.push(job);
        }
        next = if count < 16 {
            state.lock().pending.pop_front()
        } else {
            None
        };
    }
    let result = batch.commit();
    for job in completed {
        let outcome = match &result {
            Ok(()) => Ok(()),
            Err(_) => Err(GatewayApplicationError::internal()),
        };
        let _ = job.done.send(outcome);
    }
}

/// Fresh uploads have a distinct storage suffix, so recovery cannot remove
/// materialized artifacts awaiting transcript projection or project snapshots.
pub(super) fn remove_orphans(
    root: &Path,
    retained: &std::collections::HashSet<String>,
) -> Result<(), GatewayApplicationError> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(GatewayApplicationError::internal_from(error)),
    };
    for entry in entries {
        let entry = entry.map_err(GatewayApplicationError::internal_from)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // A write-through fallback can be interrupted between its two renames.
        if let Some(id) = name
            .strip_prefix('.')
            .and_then(|name| name.split_once(".upload."))
            .map(|(id, _)| id)
            && upload::valid_id(id)
            && name.ends_with(".tmp")
        {
            std::fs::remove_file(entry.path()).map_err(GatewayApplicationError::internal_from)?;
            continue;
        }
        let Some(id) = name
            .strip_suffix(".upload")
            .or_else(|| name.strip_suffix(".upload.txt"))
        else {
            continue;
        };
        if upload::valid_id(id) && !retained.contains(id) {
            std::fs::remove_file(entry.path()).map_err(GatewayApplicationError::internal_from)?;
            // A failed PDF preparation may have left its reconstructible sidecar.
            match std::fs::remove_file(entry.path().with_extension("upload.txt")) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(GatewayApplicationError::internal_from(error)),
            }
        }
    }
    Ok(())
}
