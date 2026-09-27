//! App admission delegates only external Ledger and file/image I/O.

use std::sync::Arc;

use crate::gateway::AppAdmissionAuthority;
use crate::gateway::AppImageFiles;
use crate::gateway::AppLedgerSourceRequest;
use crate::gateway::AppMessageFiles;
use crate::gateway::AppSourceDocument;
use crate::gateway::AppSourceSnapshotRequest;
use crate::gateway::ApplicationFuture;
use crate::gateway::GatewayApplicationError;
use crate::gateway::MaterializedResponderFile;
use crate::gateway::VisualAdmissionRequest;
use butler_ledger::project_ledger::ProjectLedger;
use butler_ledger::project_ledger::ProjectLedgerBinding;
use butler_ledger::project_ledger::ProjectLedgerReadError;
use butler_models::models::ModelConfiguration;

pub(crate) struct AppAdmission {
    ledger: ProjectLedger,
    images: Arc<AppImageFiles>,
    models: Arc<ModelConfiguration>,
    mcp: Arc<butler_models::mcp_client::McpClient>,
    artifacts: Arc<AppMessageFiles>,
}

impl AppAdmission {
    pub(crate) fn new(
        ledger: ProjectLedger,
        images: Arc<AppImageFiles>,
        models: Arc<ModelConfiguration>,
        mcp: Arc<butler_models::mcp_client::McpClient>,
        artifacts: Arc<AppMessageFiles>,
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

impl AppAdmissionAuthority for AppAdmission {
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
            let catalog = Box::pin(crate::host::catalog_for_visual_admission(
                &models,
                &mcp,
                &request.model_ref,
            ))
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
            source: None,
        },
        ProjectLedgerReadError::DashboardUnavailable { code: _, .. } => unavailable(),
        ProjectLedgerReadError::DashboardInternal { code: _, .. }
        | ProjectLedgerReadError::Resolution { code: _, .. }
        | ProjectLedgerReadError::RecordShow { code: _, .. }
        | ProjectLedgerReadError::Owner { code: _, .. } => GatewayApplicationError::internal(),
    }
}

fn unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "source_unavailable".into(),
        message: "Source unavailable.".into(),
        source: None,
    }
}
