//! Serializes logical App listener lifecycle while the native service stays alive.

use std::{path::PathBuf, sync::Arc};

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{btcc::BtccError, gateway::NativeInboundQueue, operations::ServiceReadiness};

use super::NativeActiveAppEndpoint;
use crate::host::{
    NativeAgentRuntime, NativeAppServer, NativeServiceConfiguration, ResolvedInstallation,
    service_configuration::{NativeAppCapturedDependencies, NativeAppServiceConfiguration},
    service_instance::mark_gateway_state,
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
}

pub(crate) struct NativeAppGatewayLifecycle {
    runtime: Arc<NativeAgentRuntime>,
    data_root: PathBuf,
    queue: Arc<NativeInboundQueue>,
    readiness: Arc<ServiceReadiness>,
    endpoint: Arc<NativeActiveAppEndpoint>,
    installation: ResolvedInstallation,
    captured_dependencies: NativeAppCapturedDependencies,
    nonce: String,
    current: Mutex<Option<NativeAppServer>>,
}

impl NativeAppGatewayLifecycle {
    pub(crate) fn new(
        runtime: Arc<NativeAgentRuntime>,
        service: &NativeServiceConfiguration,
        queue: Arc<NativeInboundQueue>,
        readiness: Arc<ServiceReadiness>,
        endpoint: Arc<NativeActiveAppEndpoint>,
        nonce: String,
    ) -> Self {
        Self {
            installation: service.installation.clone(),
            data_root: service.data_root.clone(),
            captured_dependencies: NativeAppCapturedDependencies::capture(&service.app),
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
        initial: &NativeAppServiceConfiguration,
    ) -> Result<bool, BtccError> {
        let mut current = self.current.lock().await;
        if !initial.enabled {
            return Ok(false);
        }
        self.require_captured_dependencies(initial)?;
        self.start_locked(&mut current, initial).await
    }

    pub(crate) async fn execute(&self, command: GatewayControlCommand) -> Result<Value, String> {
        let mut current = self.current.lock().await;
        match command {
            GatewayControlCommand::Status => self.view(&current).await,
            GatewayControlCommand::Test => self.test(&current).await,
            GatewayControlCommand::Start => {
                let desired = NativeAppServiceConfiguration::capture(&self.data_root);
                self.require_captured_dependencies_text(&desired)?;
                if !desired.enabled {
                    let mut view = self.view(&current).await?;
                    view["started"] = Value::Bool(false);
                    view["reason"] = Value::String("disabled".into());
                    return Ok(view);
                }
                let already = current.is_some();
                self.start_locked(&mut current, &desired)
                    .await
                    .map_err(error_text)?;
                let mut view = self.view(&current).await?;
                view["started"] = Value::Bool(!already);
                view["alreadyRunning"] = Value::Bool(already);
                Ok(view)
            }
            GatewayControlCommand::Stop => {
                let was_running = current.is_some();
                self.stop_locked(&mut current).await?;
                let mut view = self.view(&current).await?;
                view["stopped"] = Value::Bool(true);
                view["alreadyStopped"] = Value::Bool(!was_running);
                Ok(view)
            }
            GatewayControlCommand::Restart => {
                let desired = NativeAppServiceConfiguration::capture(&self.data_root);
                self.require_captured_dependencies_text(&desired)?;
                if !desired.enabled {
                    let mut view = self.view(&current).await?;
                    view["restarted"] = Value::Bool(false);
                    view["reason"] = Value::String("disabled".into());
                    return Ok(view);
                }
                self.stop_locked(&mut current).await?;
                self.start_locked(&mut current, &desired)
                    .await
                    .map_err(error_text)?;
                let mut view = self.view(&current).await?;
                view["restarted"] = Value::Bool(true);
                Ok(view)
            }
            GatewayControlCommand::RestartHandoffResult => {
                Err("gateway_command_requires_journal_owner".into())
            }
        }
    }

    pub(crate) async fn close(&self) -> Result<(), BtccError> {
        let mut current = self.current.lock().await;
        self.stop_locked(&mut current)
            .await
            .map_err(|message| BtccError::new("app_gateway_close_failed", message))
    }

    async fn start_locked(
        &self,
        current: &mut Option<NativeAppServer>,
        app_config: &NativeAppServiceConfiguration,
    ) -> Result<bool, BtccError> {
        if current.is_some() {
            return Ok(false);
        }
        let mut server = NativeAppServer::open(
            &self.runtime,
            &self.data_root,
            &self.installation,
            app_config,
            self.queue.clone(),
            self.readiness.clone(),
        )
        .await?;
        let address = server.local_addr();
        if !health_check(
            &format!("http://{address}"),
            app_config.gateway_config().local_auth,
        )
        .await
        {
            if let Err(error) = server.close_application().await {
                *current = Some(server);
                return Err(BtccError::new(
                    "app_gateway_close_failed",
                    format!("initial health check failed; cleanup also failed: {error}"),
                ));
            }
            return Err(BtccError::new(
                "app_gateway_health_check_failed",
                "App gateway did not become healthy after initialization",
            ));
        }
        self.endpoint.publish(address, app_config);
        if let Err(error) = self.persist(true, Some(format!("http://{address}")), app_config) {
            self.endpoint.clear();
            if let Err(close_error) = server.close_application().await {
                *current = Some(server);
                return Err(BtccError::new(
                    "app_gateway_close_failed",
                    format!("instance state update failed; cleanup also failed: {close_error}"),
                ));
            }
            return Err(BtccError::new(
                "native_service_instance_state_unavailable",
                error,
            ));
        }
        *current = Some(server);
        Ok(true)
    }

    async fn stop_locked(&self, current: &mut Option<NativeAppServer>) -> Result<(), String> {
        if let Some(server) = current.as_mut() {
            server
                .close_application()
                .await
                .map_err(|error| error.to_string())?;
            drop(current.take());
        }
        self.endpoint.clear();
        let config = NativeAppServiceConfiguration::capture(&self.data_root);
        self.persist(false, None, &config)
    }

    fn require_captured_dependencies(
        &self,
        desired: &NativeAppServiceConfiguration,
    ) -> Result<(), BtccError> {
        if self.captured_dependencies.matches(desired) {
            Ok(())
        } else {
            Err(BtccError::new(
                "service_restart_required",
                "App database or local authority changed; restart the native service to apply it",
            ))
        }
    }

    fn require_captured_dependencies_text(
        &self,
        desired: &NativeAppServiceConfiguration,
    ) -> Result<(), String> {
        self.require_captured_dependencies(desired)
            .map_err(error_text)
    }

    fn persist(
        &self,
        active: bool,
        address: Option<String>,
        config: &NativeAppServiceConfiguration,
    ) -> Result<(), String> {
        mark_gateway_state(
            &self.data_root,
            &self.nonce,
            &self.installation,
            active,
            address,
            config.gateway_config().local_auth.required,
        )
    }

    async fn view(&self, current: &Option<NativeAppServer>) -> Result<Value, String> {
        let desired = NativeAppServiceConfiguration::capture(&self.data_root);
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
            },
            "nextActions":next_actions,
        }))
    }

    async fn test(&self, current: &Option<NativeAppServer>) -> Result<Value, String> {
        let mut view = self.view(current).await?;
        let result = view["enabled"] == true && view["running"] == true;
        view["ok"] = Value::Bool(result);
        Ok(view)
    }
}

async fn health_check(base_url: &str, auth: crate::gateway::LocalAuthConfig) -> bool {
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
    format!("{}: {}", error.code, error.message)
}
