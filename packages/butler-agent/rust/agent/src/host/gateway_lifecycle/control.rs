//! Private loopback control protocol for the logical App lifecycle.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::btcc::StorageEffectJournal;
use crate::host::{
    ResolvedInstallation,
    service_instance::{
        instance_is_locked, process_matches, read_record, validate_write_destinations,
    },
};

use super::{GatewayControlCommand, NativeAppGatewayLifecycle};

const CONTROL_SCHEMA: &str = "butler.native-app-gateway-control.v1";
const MAX_FRAME_BYTES: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(90);

pub(crate) struct GatewayControlServer {
    endpoint: String,
    token: String,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    schema: String,
    nonce: String,
    token: String,
    command: GatewayControlCommand,
    #[serde(default)]
    intent_id: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ControlResponse {
    schema: String,
    result: Value,
}

impl GatewayControlServer {
    pub(crate) async fn bind(
        data_root: std::path::PathBuf,
        installation: ResolvedInstallation,
        nonce: String,
        lifecycle: Arc<NativeAppGatewayLifecycle>,
        effects: Arc<StorageEffectJournal>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "gateway_control_bind_failed".to_owned())?;
        let address = listener
            .local_addr()
            .map_err(|_| "gateway_control_bind_failed".to_owned())?;
        let endpoint = address.to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let worker_nonce = nonce.clone();
        let worker_token = token.clone();
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    () = worker_shutdown.cancelled() => break,
                    value = listener.accept() => value,
                };
                let Ok((mut stream, _peer)) = accepted else {
                    continue;
                };
                let root = data_root.clone();
                let installation = installation.clone();
                let nonce = worker_nonce.clone();
                let token = worker_token.clone();
                let lifecycle = lifecycle.clone();
                let effects = effects.clone();
                let _ = serve_one(
                    &mut stream,
                    &root,
                    &installation,
                    &nonce,
                    &token,
                    &lifecycle,
                    &effects,
                )
                .await;
            }
        });
        Ok(Self {
            endpoint,
            token,
            shutdown,
            task: Some(task),
        })
    }

    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    pub(crate) async fn close(mut self) -> Result<(), String> {
        self.shutdown.cancel();
        let task = self
            .task
            .take()
            .ok_or_else(|| "gateway_control_task_missing".to_owned())?;
        timeout(COMMAND_TIMEOUT + Duration::from_secs(4), task)
            .await
            .map_err(|_| "gateway_control_shutdown_timeout".to_owned())?
            .map_err(|_| "gateway_control_task_failed".to_owned())
    }
}

async fn serve_one(
    stream: &mut TcpStream,
    data_root: &std::path::Path,
    installation: &ResolvedInstallation,
    nonce: &str,
    token: &str,
    lifecycle: &NativeAppGatewayLifecycle,
    effects: &StorageEffectJournal,
) -> Result<(), String> {
    let request = timeout(IO_TIMEOUT, read_frame::<ControlRequest>(stream))
        .await
        .map_err(|_| "gateway_control_request_timeout".to_owned())??;
    let valid = request.schema == CONTROL_SCHEMA
        && request.nonce == nonce
        && constant_time_equal(request.token.as_bytes(), token.as_bytes())
        && validate_write_destinations(data_root, installation).is_ok()
        && instance_is_locked(data_root).unwrap_or(false)
        && read_record(data_root).ok().flatten().is_some_and(|record| {
            (record.state == "ready"
                || (matches!(request.command, GatewayControlCommand::RestartHandoffResult)
                    && record.state == "stopping"))
                && record.nonce == nonce
                && record
                    .control_token
                    .as_deref()
                    .is_some_and(|stored| constant_time_equal(stored.as_bytes(), token.as_bytes()))
                && process_matches(&record).unwrap_or(false)
        });
    let result = if valid {
        let command = async {
            if matches!(request.command, GatewayControlCommand::RestartHandoffResult) {
                let key = request
                    .intent_id
                    .as_deref()
                    .ok_or("restart_handoff_result_invalid")?;
                let state = restart_outcome(request.outcome.as_deref())?;
                effects
                    .finish_restart_handoff(key.to_owned(), state)
                    .await
                    .map_err(|error| {
                        format!("{}: journal result could not be recorded", error.code())
                    })?;
                Ok(json!({"recorded":true}))
            } else {
                lifecycle.execute(request.command).await
            }
        };
        match timeout(COMMAND_TIMEOUT, command).await {
            Err(_) => {
                json!({"ok":false,"error":{"code":"gateway_lifecycle_timeout","message":"Gateway lifecycle command timed out"}})
            }
            Ok(Ok(data)) => json!({"ok":true,"data":data}),
            Ok(Err(message)) => {
                let (code, message) = lifecycle_error_parts(&message);
                json!({"ok":false,"error":{"code":code,"message":message}})
            }
        }
    } else {
        json!({"ok":false,"error":{"code":"gateway_control_identity_invalid","message":"Gateway control identity could not be verified"}})
    };
    timeout(
        IO_TIMEOUT,
        write_frame(
            stream,
            &ControlResponse {
                schema: CONTROL_SCHEMA.to_owned(),
                result,
            },
        ),
    )
    .await
    .map_err(|_| "gateway_control_response_timeout".to_owned())?
}

fn restart_outcome(value: Option<&str>) -> Result<&'static str, String> {
    match value {
        Some("ready") => Ok("ready"),
        Some("target_gone") => Ok("target_gone"),
        Some("target_changed") => Ok("target_changed"),
        Some("stop_failed") => Ok("stop_failed"),
        Some("start_failed") => Ok("start_failed"),
        Some("start_unverified") => Ok("start_unverified"),
        Some("precondition_failed") => Ok("precondition_failed"),
        _ => Err("restart_handoff_result_invalid".into()),
    }
}

pub(crate) async fn report_restart_handoff(
    record: &crate::host::service_instance::InstanceRecord,
    key: &str,
    outcome: &str,
) -> Result<(), String> {
    restart_outcome(Some(outcome))?;
    let endpoint = record
        .control_endpoint
        .as_deref()
        .ok_or("gateway_control_unavailable")?;
    let address: SocketAddr = endpoint
        .parse()
        .map_err(|_| "gateway_control_identity_invalid")?;
    if !address.ip().is_loopback() {
        return Err("gateway_control_identity_invalid".into());
    }
    let token = record
        .control_token
        .as_deref()
        .ok_or("gateway_control_unavailable")?;
    let mut stream = timeout(IO_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|_| "gateway_control_timeout".to_owned())?
        .map_err(|_| "gateway_control_unavailable".to_owned())?;
    let request = serde_json::json!({
        "schema":CONTROL_SCHEMA,"nonce":record.nonce,"token":token,
        "command":"restart_handoff_result","intent_id":key,"outcome":outcome,
    });
    timeout(IO_TIMEOUT, write_frame(&mut stream, &request))
        .await
        .map_err(|_| "gateway_control_timeout".to_owned())??;
    let response: ControlResponse = timeout(IO_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| "gateway_control_timeout".to_owned())??;
    if response.schema != CONTROL_SCHEMA || response.result["ok"] != true {
        return Err(response.result["error"]["code"]
            .as_str()
            .unwrap_or("restart_handoff_result_failed")
            .to_owned());
    }
    Ok(())
}

fn lifecycle_error_parts(message: &str) -> (&str, &str) {
    message
        .split_once(": ")
        .filter(|(code, _)| {
            !code.is_empty()
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
        .unwrap_or(("gateway_lifecycle_failed", message))
}

async fn read_frame<T: for<'de> Deserialize<'de>>(stream: &mut TcpStream) -> Result<T, String> {
    let length = stream
        .read_u32()
        .await
        .map_err(|_| "gateway_control_request_invalid".to_owned())? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("gateway_control_request_invalid".into());
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| "gateway_control_request_invalid".to_owned())?;
    serde_json::from_slice(&bytes).map_err(|_| "gateway_control_request_invalid".into())
}

async fn write_frame<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| "gateway_control_response_invalid".to_owned())?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err("gateway_control_response_invalid".into());
    }
    stream
        .write_u32(u32::try_from(bytes.len()).unwrap_or(u32::MAX))
        .await
        .map_err(|_| "gateway_control_response_failed".to_owned())?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| "gateway_control_response_failed".to_owned())?;
    stream
        .flush()
        .await
        .map_err(|_| "gateway_control_response_failed".to_owned())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}
