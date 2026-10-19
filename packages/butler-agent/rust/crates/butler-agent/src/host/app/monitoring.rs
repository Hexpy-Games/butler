//! Native monitor reads projected from Operations and existing BTCC owners.

mod events;
mod quota;
mod work_status;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Value, json};
use tokio::sync::broadcast;

use butler_gateway::gateway::{
    AppBoundWorkStatusFact, AppMonitorPage, AppMonitoringPort, AppUsageMonitorQuery,
    ApplicationFuture, GatewayApplicationError,
};
use butler_models::models::ModelCatalog;
use butler_runtime::operations::{
    ProviderQuotaPoller, ProviderQuotaStore, ProviderQuotaUpdate, ProviderQuotaView,
    QuotaPollTrigger, UsageMonitor, UsageMonitorSources,
};
use butler_turn::btcc::SessionWorkRepository;

use crate::host::AgentRuntime;

pub(crate) struct AppMonitoring {
    lineage: Arc<butler_runtime::operations::UsageLineage>,
    data_root: PathBuf,
    session_work: Arc<SessionWorkRepository>,
    catalog: Arc<ModelCatalog>,
    quota: Arc<ProviderQuotaStore>,
    /// Polls the providers' usage endpoints into `quota`.
    poller: Option<Arc<ProviderQuotaPoller>>,
    /// The parsed usage log and transcript activity, kept between reads.
    usage: Arc<UsageMonitor>,
}

impl AppMonitoring {
    /// Monitoring over the runtime's work, catalog prices and provider quota.
    pub(crate) fn for_runtime(
        runtime: &AgentRuntime,
        data_root: &Path,
        lineage: Arc<butler_runtime::operations::UsageLineage>,
    ) -> Self {
        let quota = runtime.models.quota.clone();
        Self {
            data_root: data_root.to_path_buf(),
            session_work: runtime.session_work.clone(),
            catalog: runtime.models.catalog.clone(),
            poller: quota::poller(
                runtime.models.configuration.clone(),
                quota.clone(),
                data_root,
            ),
            quota,
            usage: Arc::new(UsageMonitor::with_owners(lineage.owners.clone())),
            lineage,
        }
    }
}

/// The usage monitor view with catalog-price cost and provider quota.
fn usage_monitor_view(
    root: &Path,
    query: &AppUsageMonitorQuery,
    monitor: &Arc<UsageMonitor>,
    catalog: &ModelCatalog,
    quota: &ProviderQuotaStore,
) -> butler_gateway::gateway::AppUsageMonitorView {
    let pricing = |model_ref: &str| catalog.pricing(model_ref);
    let quota_view = |provider_id: &str| quota.view(provider_id);
    let sources = UsageMonitorSources {
        pricing: &pricing,
        quota: &quota_view,
        quota_providers: quota.provider_ids(),
    };
    let mut view = monitor.read_prepared_at(
        root,
        query.runtime_session_id.as_deref(),
        query.usage_scope.as_deref(),
        query.since_ts,
        query
            .until_ts
            .unwrap_or_else(|| (chrono::Utc::now().timestamp_millis() + 1) as f64),
        Some(&sources),
    );
    // Echo the id the client asked with, not the runtime's spelling of it.
    if let (Some(filters), Some(session_id)) = (view.get_mut("filters"), &query.session_id) {
        filters["sessionId"] = json!(session_id);
    }
    butler_gateway::gateway::AppUsageMonitorView {
        view,
        monitor: monitor.clone(),
    }
}

impl AppMonitoringPort for AppMonitoring {
    fn work_status(&self) -> ApplicationFuture<Vec<AppBoundWorkStatusFact>> {
        let session_work = self.session_work.clone();
        Box::pin(async move { work_status::read(session_work).await })
    }

    fn usage_monitor(
        &self,
        query: AppUsageMonitorQuery,
    ) -> ApplicationFuture<butler_gateway::gateway::AppUsageMonitorView> {
        let root = self.data_root.clone();
        let catalog = self.catalog.clone();
        let quota = self.quota.clone();
        let monitor = self.usage.clone();
        let lineage = self.lineage.clone();
        // The Settings usage page reads the whole-process monitor (no
        // session): opening it starts the quota polls that are due, and the
        // view answers with the stored quota; the quota broadcast delivers
        // what the polls find.
        if let Some(poller) = self.poller.clone() {
            poller.sync_switches();
            if query.session_id.is_none() {
                quota::poll_in_background(poller, QuotaPollTrigger::SettingsOpened);
            }
        }
        Box::pin(async move {
            let _read = lineage.read.lock().await;
            let refresh = (root.clone(), catalog.clone(), monitor.clone());
            tokio::task::spawn_blocking(move || {
                refresh
                    .2
                    .refresh_owners(&refresh.0, &|model| refresh.1.pricing(model));
            })
            .await
            .map_err(GatewayApplicationError::internal_from)?;
            lineage.resolve().await;
            // The first read parses the usage log and every transcript:
            // keep that off the async workers.
            let mut view = tokio::task::spawn_blocking(move || {
                usage_monitor_view(&root, &query, &monitor, &catalog, &quota)
            })
            .await
            .map_err(GatewayApplicationError::internal_from)?;
            if let Some(object) = view.view.as_object_mut() {
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

    fn provider_quota(
        &self,
        provider_id: String,
        refresh: bool,
    ) -> ApplicationFuture<ProviderQuotaView> {
        let quota = self.quota.clone();
        let poller = self.poller.clone();
        Box::pin(async move {
            match poller {
                Some(poller) if refresh => {
                    quota::poll_explicit(poller, provider_id.clone()).await;
                }
                Some(poller) => poller.sync_switches(),
                None => {}
            }
            Ok(quota.view(&provider_id))
        })
    }

    fn provider_quota_updates(&self) -> Option<broadcast::Receiver<ProviderQuotaUpdate>> {
        Some(self.quota.subscribe())
    }
}

pub(in crate::host) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
