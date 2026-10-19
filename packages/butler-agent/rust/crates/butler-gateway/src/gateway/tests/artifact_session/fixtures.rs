use super::*;

mod fakes;
mod memory_management;
pub(super) use fakes::test_db_path;

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use bytes::Bytes;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::gateway::{
    AppAdmissionAuthority, AppApplication, AppApplicationConfig, AppApplicationDependencies,
    AppApprovalClaims, AppArtifactMaterializer, AppAuthorityDecision, AppAuthorityDecisionInput,
    AppAuthorityHandoff, AppAuthorityPage, AppContextBudgetFacts, AppContextReadFacts,
    AppContextReadPort, AppContextReadQuery, AppContextUsage, AppExecutorReadiness, AppFileWrite,
    AppIdentityClock, AppLedgerSourceRequest, AppMessageFileSnapshot, AppMessageFileStorage,
    AppModelMetadata, AppNativeAssetResolver, AppNativeIngress, AppQueueOwnerLiveness,
    AppRuntimeInfoProvider, AppSessionBranchQuery, AppSessionWorkProgress,
    AppSessionWorkspaceProvisioner, AppSessionWorkspaceSnapshot, AppSettingsFacts,
    AppSettingsFactsProvider, AppSettingsMutationPort, AppSourceDocument, AppSourceSnapshotRequest,
    AppTurn, AppWorkProgress, ArtifactMaterializationRequest, ClaimedNativeSnapshot,
    EnqueueReceipt, GatewayApplicationError, GatewayConfig, MaterializedResponderFile,
    ResolvedNativeAssets, RuntimeReadinessView, VisualAdmissionRequest,
};
use butler_turn::btcc::ReasoningEffort;

pub(crate) async fn start_real(application: Arc<AppApplication>) -> GatewayServer {
    serve_on_free_pair(application, GatewayConfig::default).await
}

pub(super) async fn artifact_request(address: std::net::SocketAddr) -> String {
    request(
        address,
        "GET /artifacts?session_id=general HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    )
    .await
}

pub(crate) async fn open_app(path: &Path) -> AppApplication {
    AppApplication::open(
        AppApplicationConfig {
            database_path: path.to_owned(),
            butler_data: path.parent().unwrap().to_owned(),
            folder_selection_secret: None,
        },
        fakes::test_dependencies(),
    )
    .await
    .unwrap()
}
