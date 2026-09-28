//! Serializes logical App listener lifecycle while the native service stays alive.

use std::{path::PathBuf, sync::Arc};

use serde_json::{Value, json};
use tokio::sync::Mutex;

use butler_gateway::gateway::InboundQueue;
use butler_runtime::operations::ServiceReadiness;
use butler_turn::btcc::BtccError;

use super::ActiveAppEndpoint;
use crate::host::service::configuration::{AppCapturedDependencies, AppServiceConfiguration};
use crate::host::service::instance::mark_gateway_state;
use crate::host::{
    AgentRuntime, AppServer, AppServerOwners, ResolvedInstallation, ServiceConfiguration,
};

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GatewayControlCommand {
    Status,
    Test,
    Start,
    Stop,
    Restart,
    RestartHandoffResult,
    /// Stop the whole service (Windows controllers; see the control server).
    ServiceStop,
}

pub(crate) struct AppGatewayLifecycle {
    runtime: Arc<AgentRuntime>,
    data_root: PathBuf,
    queue: Arc<InboundQueue>,
    readiness: Arc<ServiceReadiness>,
    endpoint: Arc<ActiveAppEndpoint>,
    installation: ResolvedInstallation,
    captured_dependencies: AppCapturedDependencies,
    nonce: String,
    current: Mutex<Option<AppServer>>,
}

impl AppGatewayLifecycle {
    pub(crate) fn new(
        runtime: Arc<AgentRuntime>,
        service: &ServiceConfiguration,
        queue: Arc<InboundQueue>,
        readiness: Arc<ServiceReadiness>,
        endpoint: Arc<ActiveAppEndpoint>,
        nonce: String,
    ) -> Self {
        Self {
            installation: service.installation.clone(),
            data_root: service.data_root.clone(),
            captured_dependencies: AppCapturedDependencies::capture(&service.app),
            runtime,
            queue,
            readiness,
            endpoint,
            nonce,
            current: Mutex::new(None),
        }
    }

    pub(crate) async fn start_initial(
        &self,
        initial: &AppServiceConfiguration,
    ) -> Result<bool, BtccError> {
        let mut current = self.current.lock().await;
        if !initial.enabled {
            return Ok(false);
        }
        self.require_captured_dependencies(initial)?;
        self.start_locked(&mut current, initial).await
    }

    pub(crate) async fn execute(
        &self,
        command: GatewayControlCommand,
    ) -> Result<Value, crate::host::HostError> {
        let mut current = self.current.lock().await;
        match command {
            GatewayControlCommand::Status => self.view(current.as_ref()).await,
            GatewayControlCommand::Test => self.test(current.as_ref()).await,
            GatewayControlCommand::Start => {
                let desired = AppServiceConfiguration::capture(&self.data_root);
                self.require_captured_dependencies_text(&desired)?;
                if !desired.enabled {
                    let mut view = self.view(current.as_ref()).await?;
                    view["started"] = Value::Bool(false);
                    view["reason"] = Value::String("disabled".into());
                    return Ok(view);
                }
                let already = current.is_some();
                self.start_locked(&mut current, &desired)
                    .await
                    .map_err(error_text)?;
                let mut view = self.view(current.as_ref()).await?;
                view["started"] = Value::Bool(!already);
                view["alreadyRunning"] = Value::Bool(already);
                Ok(view)
            }
            GatewayControlCommand::Stop => {
                let was_running = current.is_some();
                self.stop_locked(&mut current).await?;
                let mut view = self.view(current.as_ref()).await?;
                view["stopped"] = Value::Bool(true);
                view["alreadyStopped"] = Value::Bool(!was_running);
                Ok(view)
            }
            GatewayControlCommand::Restart => {
                let desired = AppServiceConfiguration::capture(&self.data_root);
                self.require_captured_dependencies_text(&desired)?;
                if !desired.enabled {
                    let mut view = self.view(current.as_ref()).await?;
                    view["restarted"] = Value::Bool(false);
                    view["reason"] = Value::String("disabled".into());
                    return Ok(view);
                }
                self.stop_locked(&mut current).await?;
                self.start_locked(&mut current, &desired)
                    .await
                    .map_err(error_text)?;
                let mut view = self.view(current.as_ref()).await?;
                view["restarted"] = Value::Bool(true);
                Ok(view)
            }
            GatewayControlCommand::RestartHandoffResult => {
                Err("gateway_command_requires_journal_owner".into())
            }
            GatewayControlCommand::ServiceStop => {
                Err("gateway_command_requires_service_owner".into())
            }
        }
    }

    pub(crate) async fn close(&self) -> Result<(), BtccError> {
        let mut current = self.current.lock().await;
        self.stop_locked(&mut current).await.map_err(|message| {
            BtccError::relayed("app_gateway_close_failed", message.to_string()).with_source(message)
        })
    }

    async fn start_locked(
        &self,
        current: &mut Option<AppServer>,
        app_config: &AppServiceConfiguration,
    ) -> Result<bool, BtccError> {
        if current.is_some() {
            return Ok(false);
        }
        let local_auth = self.captured_dependencies.local_auth();
        let mut server = AppServer::open(
            &self.runtime,
            &self.data_root,
            &self.installation,
            app_config,
            AppServerOwners {
                queue: self.queue.clone(),
                receipt: self.readiness.clone(),
                local_auth: local_auth.clone(),
            },
        )
        .await?;
        let address = server.local_addr();
        if !health_check(&format!("http://{address}"), local_auth.clone()).await {
            if let Err(error) = server.close_application().await {
                *current = Some(server);
                return Err(BtccError::relayed(
                    "app_gateway_close_failed",
                    format!("initial health check failed; cleanup also failed: {error}"),
                ));
            }
            return Err(BtccError::relayed(
                "app_gateway_health_check_failed",
                "App gateway did not become healthy after initialization",
            ));
        }
        self.endpoint.publish(address, app_config, local_auth);
        if let Err(error) = self.persist(true, Some(format!("http://{address}")), app_config) {
            self.endpoint.clear();
            if let Err(close_error) = server.close_application().await {
                *current = Some(server);
                return Err(BtccError::relayed(
                    "app_gateway_close_failed",
                    format!("instance state update failed; cleanup also failed: {close_error}"),
                ));
            }
            return Err(BtccError::relayed(
                "native_service_instance_state_unavailable",
                error.to_string(),
            ));
        }
        *current = Some(server);
        Ok(true)
    }

    async fn stop_locked(
        &self,
        current: &mut Option<AppServer>,
    ) -> Result<(), crate::host::HostError> {
        if let Some(server) = current.as_mut() {
            server
                .close_application()
                .await
                .map_err(crate::host::HostError::from_error)?;
            drop(current.take());
        }
        self.endpoint.clear();
        let config = AppServiceConfiguration::capture(&self.data_root);
        self.persist(false, None, &config)
    }

    fn require_captured_dependencies(
        &self,
        desired: &AppServiceConfiguration,
    ) -> Result<(), BtccError> {
        if self.captured_dependencies.matches(desired) {
            Ok(())
        } else {
            Err(BtccError::relayed(
                "service_restart_required",
                "App database or local authority changed; restart the native service to apply it",
            ))
        }
    }

    fn require_captured_dependencies_text(
        &self,
        desired: &AppServiceConfiguration,
    ) -> Result<(), crate::host::HostError> {
        self.require_captured_dependencies(desired)
            .map_err(error_text)
            .map_err(crate::host::HostError::from)
    }

    fn persist(
        &self,
        active: bool,
        address: Option<String>,
        config: &AppServiceConfiguration,
    ) -> Result<(), crate::host::HostError> {
        mark_gateway_state(
            &self.data_root,
            &self.nonce,
            &self.installation,
            active,
            address,
            config.gateway_config().local_auth.required,
        )
    }

    async fn view(&self, current: Option<&AppServer>) -> Result<Value, crate::host::HostError> {
        let desired = AppServiceConfiguration::capture(&self.data_root);
        let active = self.endpoint.snapshot();
        let enabled = desired.enabled;
        let running = match (current, active.as_ref()) {
            (Some(_), Some(active)) => {
                health_check(&active.base_url, active.local_auth.clone()).await
            }
            _ => false,
        };
        let restart_required = !self.captured_dependencies.matches(&desired)
            || active.as_ref().is_some_and(|active| {
                active.configured_host != desired.host
                    || active.configured_port != desired.port
                    || active.database_path != desired.db_path
                    || active.local_auth.required != desired.gateway_config().local_auth.required
                    || active.local_auth.token() != desired.gateway_config().local_auth.token()
            });
        let (status, next_actions) = if !enabled {
            ("disabled", vec!["butler gateway enable app"])
        } else if running {
            ("online", vec!["butler gateway status app"])
        } else {
            ("offline", vec!["butler gateway start app"])
        };
        Ok(json!({
            "id":"app",
            "title":"Butler App Gateway",
            "lifecycle":"process",
            "transport":"app",
            "enabled":enabled,
            "configured":!desired.host.is_empty() && desired.port > 0,
            "running":running,
            "status":status,
            "restartRequired":restart_required,
            "credentials":{},
            "config":{
                "host":desired.host,
                "port":desired.port,
                "serverUrl":format!("http://{}:{}", desired.host, desired.port),
                "dbConfigured":desired.db_configured,
                "remoteAccessEnabled":desired.remote_access_enabled(),
                "allowedHosts":desired.allowed_hosts(),
            },
            "nextActions":next_actions,
        }))
    }

    async fn test(&self, current: Option<&AppServer>) -> Result<Value, crate::host::HostError> {
        let mut view = self.view(current).await?;
        let result = view["enabled"] == true && view["running"] == true;
        view["ok"] = Value::Bool(result);
        Ok(view)
    }
}

async fn health_check(base_url: &str, auth: butler_gateway::gateway::LocalAuthConfig) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
    else {
        return false;
    };
    let mut request = client.get(format!("{}/health", base_url.trim_end_matches('/')));
    if auth.required {
        let Some(token) = auth.token() else {
            return false;
        };
        request = request.bearer_auth(token);
    }
    let Ok(response) = request.send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response.json::<Value>().await.ok().is_some_and(|body| {
        body["protocol_version"] == "butler.app.v1" && body["data"]["ok"] == true
    })
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn error_text(error: BtccError) -> String {
    format!("{}: {}", error.code(), error.message())
}
