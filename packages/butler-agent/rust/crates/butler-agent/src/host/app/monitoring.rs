//! Native monitor reads projected from Operations and existing BTCC owners.

mod events;
mod logs;
mod work_status;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Value, json};
use tokio::sync::broadcast;

use butler_gateway::gateway::{
    AppBoundWorkStatusFact, AppDeveloperLogsQuery, AppMonitorPage, AppMonitoringPort,
    AppUsageMonitorQuery, ApplicationFuture,
};
use butler_models::models::ModelCatalog;
use butler_runtime::operations::{
    ProviderQuotaStore, ProviderQuotaUpdate, ProviderQuotaView, UsageMonitorSources,
};
use butler_turn::btcc::SessionWorkRepository;

use crate::host::AgentRuntime;

pub(crate) struct AppMonitoring {
    data_root: PathBuf,
    session_work: Arc<SessionWorkRepository>,
    catalog: Arc<ModelCatalog>,
    quota: Arc<ProviderQuotaStore>,
}

impl AppMonitoring {
    /// Monitoring over the runtime's work, catalog prices and provider quota.
    pub(crate) fn for_runtime(runtime: &AgentRuntime, data_root: &Path) -> Self {
        Self {
            data_root: data_root.to_path_buf(),
            session_work: runtime.session_work.clone(),
            catalog: runtime.models.catalog.clone(),
            quota: runtime.models.quota.clone(),
        }
    }
}

/// The usage monitor view with catalog-price cost and provider quota.
fn usage_monitor_view(
    root: &Path,
    query: &AppUsageMonitorQuery,
    catalog: &ModelCatalog,
    quota: &ProviderQuotaStore,
) -> Value {
    let pricing = |model_ref: &str| catalog.pricing(model_ref);
    let quota_view = |provider_id: &str| quota.view(provider_id);
    let sources = UsageMonitorSources {
        pricing: &pricing,
        quota: &quota_view,
        quota_providers: quota.provider_ids(),
    };
    butler_runtime::operations::read_usage_monitor(
        root,
        query.session_id.as_deref(),
        query.since_ts,
        Some(&sources),
    )
}

impl AppMonitoringPort for AppMonitoring {
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>> {
        let session_work = self.session_work.clone();
        Box::pin(async move { work_status::read(session_work).await })
    }

    fn usage_monitor(&self, query: AppUsageMonitorQuery) -> ApplicationFuture<Value> {
        let root = self.data_root.clone();
        let catalog = self.catalog.clone();
        let quota = self.quota.clone();
        Box::pin(async move {
            let mut view = usage_monitor_view(&root, &query, &catalog, &quota);
            if let Some(object) = view.as_object_mut() {
                object.insert("generated_at".into(), json!(now_iso()));
                object.insert("raw_text_included".into(), json!(false));
            }
            Ok(view)
        })
    }

    fn system_events(&self, page: AppMonitorPage) -> ApplicationFuture<Value> {
        let root = self.data_root.clone();
        Box::pin(async move { Ok(events::read(&root, page)) })
    }

    fn developer_logs(&self, query: AppDeveloperLogsQuery) -> ApplicationFuture<Value> {
        let root = self.data_root.clone();
        Box::pin(async move { logs::read(&root, &query) })
    }

    fn provider_quota(&self, provider_id: String) -> ApplicationFuture<ProviderQuotaView> {
        let view = self.quota.view(&provider_id);
        Box::pin(async move { Ok(view) })
    }

    fn provider_quota_updates(&self) -> Option<broadcast::Receiver<ProviderQuotaUpdate>> {
        Some(self.quota.subscribe())
    }
}

pub(in crate::host) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
