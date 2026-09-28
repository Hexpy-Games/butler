//! On-demand App image derivatives and verified provider payloads.

mod admission;
mod errors;
mod files;
mod payload;

#[cfg(test)]
pub(crate) use errors::image_error;
pub(crate) use errors::{ImageErrorCode, localize_image_error};

use parking_lot::Mutex;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use super::{AppMessageFileSnapshot, GatewayApplicationError};
use butler_models::models::ModelProviderMetadata;

pub struct AppImageFiles {
    root: PathBuf,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Arc<Mutex<bool>>,
}

impl AppImageFiles {
    pub fn new(data_root: &Path) -> Self {
        Self {
            root: data_root.join("app-server/message-files"),
            permits: Arc::new(Semaphore::new(1)),
            jobs: TaskTracker::new(),
            closing: Arc::new(Mutex::new(false)),
        }
    }

    pub async fn close(&self) -> Result<(), GatewayApplicationError> {
        {
            let mut closing = self.closing.lock();
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }

    pub async fn admit_visual(
        &self,
        files: Vec<AppMessageFileSnapshot>,
        model_ref: &str,
        catalog: &[ModelProviderMetadata],
    ) -> Result<Value, GatewayApplicationError> {
        self.ensure_open()?;
        let images = files.iter().filter(|file| file.kind == "image").count();
        if images == 0 {
            return Ok(Value::Array(
                files
                    .into_iter()
                    .map(|file| Value::String(file.id))
                    .collect(),
            ));
        }
        let entry = catalog
            .iter()
            .find(|item| item.model_ref == model_ref || item.model_id == model_ref)
            .cloned();
        let root = self.root.clone();
        self.run(move || admission::admit(&root, &files, entry.as_ref()))
            .await
    }

    pub async fn validate_queued_visual(
        &self,
        attachments: &Value,
        files: &[AppMessageFileSnapshot],
        model_ref: &str,
        catalog: &[ModelProviderMetadata],
    ) -> Result<Option<Value>, GatewayApplicationError> {
        self.ensure_open()?;
        let Some(admission) = admission::parse_queued(attachments)? else {
            return Ok(None);
        };
        let entry = catalog
            .iter()
            .find(|item| item.model_ref == model_ref || item.model_id == model_ref)
            .cloned();
        let files = files.to_vec();
        let root = self.root.clone();
        self.run(move || admission::validate(&root, admission, &files, entry.as_ref()))
            .await
            .map(Some)
    }

    fn ensure_open(&self) -> Result<(), GatewayApplicationError> {
        if *self.closing.lock() {
            Err(GatewayApplicationError::internal())
        } else {
            Ok(())
        }
    }

    async fn run<T, F>(&self, work: F) -> Result<T, GatewayApplicationError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, GatewayApplicationError> + Send + 'static,
    {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(GatewayApplicationError::internal_from)?;
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock();
            if *closing {
                return Err(GatewayApplicationError::internal());
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    work()
                })
                .await
                .map_err(GatewayApplicationError::internal_from)
                .and_then(|result| result);
                let _ = sender.send(result);
            });
        }
        receiver
            .await
            .map_err(GatewayApplicationError::internal_from)?
    }
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
