use super::*;

mod fakes;
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
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::btcc::ReasoningEffort;
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
    AppWorkProgress, ArtifactMaterializationRequest, ClaimedNativeSnapshot, GatewayApplication,
    GatewayApplicationError, GatewayConfig, MaterializedResponderFile, NativeAppTurn,
    NativeEnqueueReceipt, ResolvedNativeAssets, RuntimeReadinessView, VisualAdmissionRequest,
};

pub(crate) async fn start_real(application: Arc<AppApplication>) -> GatewayServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let application: Arc<dyn GatewayApplication> = application;
    serve_gateway(listener, application, GatewayConfig::default())
        .await
        .unwrap()
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
            project_workspace_root: path.parent().unwrap().to_owned(),
            folder_selection_secret: None,
        },
        fakes::test_dependencies(),
    )
    .await
    .unwrap()
}
