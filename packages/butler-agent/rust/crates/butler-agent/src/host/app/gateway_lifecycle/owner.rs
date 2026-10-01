//! Serializes logical App listener lifecycle while the native service stays alive.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU16, Ordering},
    },
};

use serde_json::{Value, json};
use tokio::{net::TcpListener, sync::Mutex};

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
    /// Keep an OS-assigned port across App-only listener restarts.
    allocated_port: AtomicU16,
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
            allocated_port: AtomicU16::new(0),
        }
    }

    pub(crate) async fn start_initial(
        &self,
        initial: &AppServiceConfiguration,
        listener: Option<TcpListener>,
    ) -> Result<bool, BtccError> {
        let mut current = self.current.lock().await;
        if !initial.enabled {
            return Ok(false);
        }
        self.require_captured_dependencies(initial)?;
        self.start_locked(&mut current, initial, listener).await
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
                self.start_locked(&mut current, &desired, None)
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
                self.start_locked(&mut current, &desired, None)
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

    pub(crate) async fn stop_accepting(&self) -> Result<(), BtccError> {
        if let Some(server) = self.current.lock().await.as_ref() {
            server.stop_accepting().await?;
        }
        Ok(())
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
        listener: Option<TcpListener>,
    ) -> Result<bool, BtccError> {
        if current.is_some() {
            return Ok(false);
        }
        let local_auth = self.captured_dependencies.local_auth();
        let port = if app_config.port == 0 {
            self.allocated_port.load(Ordering::Relaxed)
        } else {
            app_config.port
        };
        let listener = match listener {
            Some(listener) => listener,
            None => AppServer::bind(&app_config.host, port).await?,
        };
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
            listener,
        )
        .await?;
        let address = server.local_addr();
        if app_config.port == 0 {
            self.allocated_port.store(address.port(), Ordering::Relaxed);
        }
        // AppServer owns the bound listener and initialized dispatch. A one-shot
        // HTTP probe can time out under load even while that listener is healthy;
        // status queries still probe it, but startup must not tear it down for that.
        self.endpoint.publish(address, app_config, local_auth);
        if let Err(error) = self
            .persist(true, Some(format!("http://{address}")), app_config)
            .await
        {
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
        crate::host::service::shutdown_trace::measure(
            "app_endpoint_persist",
            self.persist(false, None, &config),
        )
        .await
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

    async fn persist(
        &self,
        active: bool,
        address: Option<String>,
        config: &AppServiceConfiguration,
    ) -> Result<(), crate::host::HostError> {
        let data_root = self.data_root.clone();
        let nonce = self.nonce.clone();
        let installation = self.installation.clone();
        let auth_required = config.gateway_config().local_auth.required;
        // Record locking and fsync must not occupy a runtime worker at shutdown.
        tokio::task::spawn_blocking(move || {
            mark_gateway_state(
                &data_root,
                &nonce,
                &installation,
                active,
                address,
                auth_required,
            )
        })
        .await
        .map_err(crate::host::HostError::from_error)?
    }

    async fn view(&self, current: Option<&AppServer>) -> Result<Value, crate::host::HostError> {
        let desired = AppServiceConfiguration::capture(&self.data_root);
        let active = self.endpoint.snapshot();
        let enabled = desired.enabled;
        let running = match (current, active.as_ref()) {
            (Some(_), Some(active)) => {
                serves_clients(&active.base_url, active.local_auth.clone()).await
            }
            _ => false,
        };
        let restart_required = !self.captured_dependencies.matches(&desired)
            || active.as_ref().is_some_and(|active| {
                active.configured_host != desired.host
                    || (desired.port != 0 && active.configured_port != desired.port)
                    || active.database_path != desired.db_path
                    || active.local_auth.required != desired.gateway_config().local_auth.required
                    || active.local_auth.token() != desired.gateway_config().local_auth.token()
            });
        let refusing = current.is_some()
            && active
                .as_ref()
                .is_some_and(|active| local_auth_unconfigured(&active.local_auth));
        let (status, next_actions) = view_status(enabled, running, refusing);
        Ok(json!({
            "memoryModel": self.runtime.memory_acquisition.subscribe().borrow().clone(),
            "id":"app",
            "title":"Butler App Gateway",
            "lifecycle":"process",
            "transport":"app",
            "enabled":enabled,
            "configured":desired.server_url().is_some(),
            "running":running,
            "status":status,
            "restartRequired":restart_required,
            "credentials":{},
            "config":{
                "host":desired.host,
                "port":desired.port,
                "serverUrl":desired.server_url(),
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

/// Whether local auth is required but has no token (its file was
/// unreadable when the service started): the gateway refuses every client.
pub(crate) fn local_auth_unconfigured(auth: &butler_gateway::gateway::LocalAuthConfig) -> bool {
    auth.required && auth.token().is_none()
}

/// The view's `status` and the commands that move the gateway on from it.
/// A gateway that is up but refuses every client is `unconfigured`, not
/// `offline`: starting it again changes nothing, the log names the
/// credential file, and a service restart reads that file again.
fn view_status(enabled: bool, running: bool, refusing: bool) -> (&'static str, Vec<&'static str>) {
    if !enabled {
        ("disabled", vec!["Settings → Security"])
    } else if running {
        ("online", vec!["butler status"])
    } else if refusing {
        ("unconfigured", vec!["butler logs", "butler restart"])
    } else {
        ("offline", vec!["butler start"])
    }
}

/// A bounded status probe; its result never controls startup admission.
fn probe_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(500))
        .build()
        .ok()
}

fn health_url(base_url: &str) -> String {
    format!("{}/health", base_url.trim_end_matches('/'))
}

/// Whether a client holding the token gets a healthy answer: the view's
/// `running`, false while the gateway refuses every client.
async fn serves_clients(base_url: &str, auth: butler_gateway::gateway::LocalAuthConfig) -> bool {
    let Some(client) = probe_client() else {
        return false;
    };
    let mut request = client.get(health_url(base_url));
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
