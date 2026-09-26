//! On-demand App image derivatives and verified provider payloads.

mod admission;
mod files;
mod payload;

use parking_lot::Mutex;
use std::{path::PathBuf, sync::Arc};

use serde_json::Value;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use super::{AppMessageFileSnapshot, GatewayApplicationError};
use crate::models::ModelProviderMetadata;

pub(crate) struct NativeAppImageFiles {
    root: PathBuf,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Arc<Mutex<bool>>,
}

impl NativeAppImageFiles {
    pub(crate) fn new(data_root: PathBuf) -> Self {
        Self {
            root: data_root.join("app-server/message-files"),
            permits: Arc::new(Semaphore::new(1)),
            jobs: TaskTracker::new(),
            closing: Arc::new(Mutex::new(false)),
        }
    }

    pub(crate) async fn close(&self) -> Result<(), GatewayApplicationError> {
        {
            let mut closing = self.closing.lock();
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }

    pub(crate) async fn admit_visual(
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

    pub(crate) async fn validate_queued_visual(
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
            Err(GatewayApplicationError::Internal)
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
            .map_err(|_| GatewayApplicationError::Internal)?;
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock();
            if *closing {
                return Err(GatewayApplicationError::Internal);
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    work()
                })
                .await
                .map_err(|_| GatewayApplicationError::Internal)
                .and_then(|result| result);
                let _ = sender.send(result);
            });
        }
        receiver
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
    }
}

fn image_error(code: &str) -> GatewayApplicationError {
    let status = match code {
        "image_payload_invalid" => 413,
        "image_manifest_invalid" => 422,
        _ => 409,
    };
    let message = match code {
        "image_model_unsupported" => {
            "현재 모델은 이미지를 읽을 수 없습니다. 이미지 지원 모델을 선택하거나 이미지를 제거하세요."
        }
        "image_capability_unknown" => {
            "현재 모델의 이미지 지원 여부를 확인할 수 없습니다. 모델 설정을 확인하거나 이미지를 제거하세요."
        }
        "image_carrier_unavailable" => {
            "현재 모델로 이미지를 전송할 수 있는 어댑터가 없습니다. 모델 연결 설정을 확인하세요."
        }
        "image_route_incompatible" => {
            "현재 모델 연결 경로는 이미지 입력과 호환되지 않습니다. 연결 설정을 확인하세요."
        }
        "image_carrier_unverified" => "이미지 전송 경로를 확인할 수 없습니다.",
        _ => "이미지 첨부를 확인할 수 없습니다.",
    };
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}
