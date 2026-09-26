//! App admission delegates only external Ledger and file/image I/O.

use std::sync::Arc;

use crate::{
    gateway::{
        AppAdmissionAuthority, AppLedgerSourceRequest, AppSourceDocument, AppSourceSnapshotRequest,
        ApplicationFuture, GatewayApplicationError, MaterializedResponderFile, NativeAppImageFiles,
        NativeAppMessageFiles, VisualAdmissionRequest,
    },
    models::ModelConfiguration,
    project_ledger::{NativeProjectLedger, ProjectLedgerBinding, ProjectLedgerReadError},
};

pub(crate) struct NativeAppAdmission {
    ledger: NativeProjectLedger,
    images: Arc<NativeAppImageFiles>,
    models: Arc<ModelConfiguration>,
    mcp: Arc<crate::mcp_client::NativeMcpClient>,
    artifacts: Arc<NativeAppMessageFiles>,
}

impl NativeAppAdmission {
    pub(crate) fn new(
        ledger: NativeProjectLedger,
        images: Arc<NativeAppImageFiles>,
        models: Arc<ModelConfiguration>,
        mcp: Arc<crate::mcp_client::NativeMcpClient>,
        artifacts: Arc<NativeAppMessageFiles>,
    ) -> Self {
        Self {
            ledger,
            images,
            models,
            mcp,
            artifacts,
        }
    }
}

impl AppAdmissionAuthority for NativeAppAdmission {
    fn read_ledger_source(
        &self,
        request: AppLedgerSourceRequest,
    ) -> ApplicationFuture<AppSourceDocument> {
        let ledger = self.ledger.clone();
        Box::pin(async move {
            let Some(ledger_project_id) = request.project.ledger_project_id else {
                return Err(unavailable());
            };
            let binding = ProjectLedgerBinding {
                app_project_id: request.project.id,
                ledger_project_id,
            };
            let source = ledger
                .read_dashboard_source(
                    binding,
                    request.source.kind,
                    request.source.id,
                    request.source.revision,
                )
                .await
                .map_err(ledger_error)?;
            Ok(AppSourceDocument {
                title: source.title,
                body: source.body,
                revision: source.revision,
            })
        })
    }

    fn snapshot_source(
        &self,
        request: AppSourceSnapshotRequest,
    ) -> ApplicationFuture<MaterializedResponderFile> {
        self.artifacts.snapshot_source(request.name, request.body)
    }

    fn admit_visual(
        &self,
        request: VisualAdmissionRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        let images = self.images.clone();
        let models = self.models.clone();
        let mcp = self.mcp.clone();
        Box::pin(async move {
            if !request.files.iter().any(|file| file.kind == "image") {
                return images
                    .admit_visual(request.files, &request.model_ref, &[])
                    .await;
            }
            let catalog =
                crate::host::catalog_for_visual_admission(&models, &mcp, &request.model_ref)
                    .await?;
            images
                .admit_visual(request.files, &request.model_ref, &catalog)
                .await
        })
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn ledger_error(error: ProjectLedgerReadError) -> GatewayApplicationError {
    match error {
        ProjectLedgerReadError::DashboardChanged => GatewayApplicationError::Public {
            status: 409,
            code: "source_changed".into(),
            message: "Source changed. Reload it.".into(),
        },
        ProjectLedgerReadError::DashboardUnavailable(_) => unavailable(),
        ProjectLedgerReadError::DashboardInternal(_)
        | ProjectLedgerReadError::Resolution(_)
        | ProjectLedgerReadError::RecordShow(_)
        | ProjectLedgerReadError::Owner(_) => GatewayApplicationError::Internal,
    }
}

fn unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "source_unavailable".into(),
        message: "Source unavailable.".into(),
    }
}
