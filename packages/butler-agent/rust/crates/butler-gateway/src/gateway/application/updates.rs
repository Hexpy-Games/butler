use super::GatewayApplicationError;

pub(super) fn update_error(
    error: &butler_runtime::operations::UpdateError,
) -> GatewayApplicationError {
    let code = error.code();
    let (status, message) = match code {
        "install_busy" | "update_status_invalid" => {
            (409, "Update state does not allow this action.")
        }
        "unsupported_component" => (400, "Only Butler App package updates are available."),
        "app_version_unavailable" => (503, "Installed Butler App version is unavailable."),
        "update_manifest_incompatible" | "update_signature_unsupported" => (
            422,
            "Update manifest is incompatible with the native App updater.",
        ),
        "update_manifest_unavailable" | "update_artifact_unavailable" => {
            (503, "Update source is unavailable.")
        }
        "update_artifact_sha256_mismatch" => (422, "Update package checksum did not match."),
        "update_cancelled" => (503, "Update request was cancelled."),
        code if code.starts_with("update_manifest_") => (422, "Update manifest is invalid."),
        code if code.starts_with("update_artifact_") => (422, "Update package is invalid."),
        _ => (500, "Update staging is unavailable."),
    };
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}

impl super::AppApplication {
    pub(super) async fn connect_update_progress(&self) {
        let storage = self.storage.clone();
        let subscribers = self.subscribers.clone();
        let clock = self.dependencies.identity_clock.clone();
        self.dependencies
            .updates
            .progress
            .set_sink(std::sync::Arc::new(move |progress| {
                let (storage, subscribers, now) =
                    (storage.clone(), subscribers.clone(), clock.now_iso());
                Box::pin(async move {
                    storage
                        .execute(move |db| {
                            super::events::append(
                                db,
                                &subscribers,
                                "updates.progress",
                                None,
                                serde_json::json!({"progress":progress})
                                    .as_object()
                                    .cloned()
                                    .unwrap_or_default(),
                                &now,
                            )
                        })
                        .await
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                })
            }))
            .await;
    }
}

pub(super) fn check(
    updates: std::sync::Arc<butler_runtime::operations::AppUpdateService>,
    request: butler_runtime::operations::UpdateRequest,
) -> crate::gateway::ApplicationFuture<serde_json::Value> {
    Box::pin(async move {
        updates
            .refresh(request)
            .await
            .map_err(|error| update_error(&error))
    })
}

pub(super) fn current(
    updates: std::sync::Arc<butler_runtime::operations::AppUpdateService>,
) -> crate::gateway::ApplicationFuture<serde_json::Value> {
    Box::pin(async move {
        updates
            .current()
            .await
            .map_err(|error| update_error(&error))
    })
}

pub(super) fn apply(
    updates: std::sync::Arc<butler_runtime::operations::AppUpdateService>,
    request: butler_runtime::operations::UpdateRequest,
) -> crate::gateway::ApplicationFuture<serde_json::Value> {
    Box::pin(async move {
        Box::pin(updates.apply(request))
            .await
            .map_err(|error| update_error(&error))
    })
}
