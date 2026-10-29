//! The consented account stream is the sole persistent MCP session.
use super::{
    PreparedOverlay,
    children::ChildGroup,
    registry::{normalize_server_config, resolve_secrets},
};
use rmcp::{
    ClientHandler, RoleClient,
    model::*,
    service::{NotificationContext, RunningService},
    transport::async_rw::AsyncRwTransport,
};
use serde_json::{Map, Value};
use std::{collections::HashMap, process::Stdio, sync::Arc};
use tokio::{
    process::{Child, Command},
    sync::Notify,
};

/// Host operation deadline. Connector processes receive this value and must
/// finish their own upstream deadline at least 1,000 ms earlier, returning a
/// structured error. Applies equally to tool calls and resource reads.
const CONNECTOR_CALL_TIMEOUT_MS: u64 = 15_000;

#[derive(Clone)]
struct Handler(Arc<Notify>);
impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("butler-connector", "1.0.0"),
        )
    }
    fn on_resource_updated(
        &self,
        params: ResourceUpdatedNotificationParam,
        _: NotificationContext<RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send {
        if params.uri == "connector://events" {
            self.0.notify_one();
        }
        std::future::ready(())
    }
}
/// Holds the verified package lease and the registered, contained child.
pub struct ConnectorSession {
    client: RunningService<RoleClient, Handler>,
    child: Child,
    _group: ChildGroup,
    _lease: Option<Arc<dyn Send + Sync>>,
    updated: Arc<Notify>,
}
impl ConnectorSession {
    /// Connect using a configuration already verified by the plugin owner.
    pub async fn open(
        prepared: PreparedOverlay,
        environment: &HashMap<String, String>,
    ) -> Result<Self, &'static str> {
        Self::open_inner(prepared, environment, true).await
    }
    /// An account-scoped operation on a different declared server.
    pub async fn operation(
        prepared: PreparedOverlay,
        environment: &HashMap<String, String>,
    ) -> Result<Self, &'static str> {
        Self::open_inner(prepared, environment, false).await
    }
    async fn open_inner(
        prepared: PreparedOverlay,
        environment: &HashMap<String, String>,
        subscribe: bool,
    ) -> Result<Self, &'static str> {
        let config =
            normalize_server_config(&prepared.config).map_err(|_| "connector_config_invalid")?;
        let secrets =
            resolve_secrets(&config, environment).map_err(|_| "connector_secret_unavailable")?;
        let mut command = Command::new(
            config
                .command
                .as_deref()
                .ok_or("connector_config_invalid")?,
        );
        command
            .args(&config.args)
            .env_clear()
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command.envs(butler_platform::command_sandbox::tool_environment(
            environment,
        ));
        command.envs(secrets.env);
        command.env(
            "BUTLER_CONNECTOR_CALL_TIMEOUT_MS",
            CONNECTOR_CALL_TIMEOUT_MS.to_string(),
        );
        if let Some(cwd) = config.cwd {
            command.current_dir(cwd);
        }
        butler_platform::process_control::isolate_group(command.as_std_mut());
        let mut child = command.spawn().map_err(|_| "connector_spawn_failed")?;
        let group = ChildGroup::register(&child).map_err(|_| "connector_containment_failed")?;
        let stdout = child.stdout.take().ok_or("connector_stdio_failed")?;
        let stdin = child.stdin.take().ok_or("connector_stdio_failed")?;
        let updated = Arc::new(Notify::new());
        let client = rmcp::service::serve_client(
            Handler(updated.clone()),
            AsyncRwTransport::<RoleClient, _, _>::new_client(stdout, stdin),
        )
        .await
        .map_err(|_| "connector_initialize_failed")?;
        if subscribe {
            #[allow(
                deprecated,
                reason = "PC0 uses the legacy resource subscription protocol"
            )]
            client
                .peer()
                .subscribe(SubscribeRequestParams::new("connector://events"))
                .await
                .map_err(|_| "connector_subscribe_failed")?;
            updated.notify_one();
        }
        Ok(Self {
            client,
            child,
            _group: group,
            _lease: prepared.lease,
            updated,
        })
    }
    /// Blocks only on a resource notification or process exit. Never polls or arms a timer.
    pub async fn changed(&mut self) -> Result<(), &'static str> {
        tokio::select! {
            _ = self.child.wait() => Err("connector_exited"),
            () = self.updated.notified() => Ok(()),
        }
    }
    pub async fn read(&self, uri: &str) -> Result<Value, &'static str> {
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(CONNECTOR_CALL_TIMEOUT_MS),
            self.client
                .peer()
                .read_resource(ReadResourceRequestParams::new(uri)),
        )
        .await
        .map_err(|_| "connector_read_timeout")?
        .map_err(|_| "connector_read_failed")?;
        let mut values = Vec::new();
        for content in result.contents {
            if let ResourceContents::TextResourceContents { text, .. } = content {
                values.push(
                    serde_json::from_str::<Value>(&text)
                        .map_err(|_| "connector_resource_invalid")?,
                );
            }
        }
        if values.len() != 1 {
            return Err("connector_resource_invalid");
        }
        values.pop().ok_or("connector_resource_invalid")
    }
    pub async fn call(
        &self,
        tool: &str,
        arguments: Map<String, Value>,
    ) -> Result<Value, &'static str> {
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(CONNECTOR_CALL_TIMEOUT_MS),
            self.client
                .peer()
                .call_tool(CallToolRequestParams::new(tool.to_owned()).with_arguments(arguments)),
        )
        .await
        .map_err(|_| "connector_tool_timeout")?
        .map_err(|_| "connector_tool_failed")?;
        serde_json::to_value(result).map_err(|_| "connector_tool_failed")
    }
    pub async fn close(mut self) {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), self.client.close()).await;
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}
