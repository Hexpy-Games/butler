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

use crate::host::ResolvedInstallation;
use crate::host::service::instance::{
    instance_is_locked, process_matches, read_record, stop_announced_for,
    validate_write_destinations,
};
use butler_turn::btcc::StorageEffectJournal;

use super::{AppGatewayLifecycle, GatewayControlCommand};

#[cfg(debug_assertions)]
mod shutdown_order;

const CONTROL_SCHEMA: &str = "butler.native-app-gateway-control.v1";
const MAX_FRAME_BYTES: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(90);

/// Requests this service's stop, as a stop request from the host does (see
/// the service's `StopSignal`).
pub(crate) type ServiceStopRequester = Arc<dyn Fn() + Send + Sync>;

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

/// What the control server answers for: this instance and its owners.
struct ControlContext {
    data_root: std::path::PathBuf,
    installation: ResolvedInstallation,
    nonce: String,
    token: String,
    lifecycle: Arc<AppGatewayLifecycle>,
    effects: Arc<StorageEffectJournal>,
    stop: ServiceStopRequester,
}

/// The owners the control server needs besides its instance identity.
pub(crate) struct ControlOwners {
    pub(crate) lifecycle: Arc<AppGatewayLifecycle>,
    pub(crate) effects: Arc<StorageEffectJournal>,
    pub(crate) stop: ServiceStopRequester,
}

impl GatewayControlServer {
    pub(crate) async fn bind(
        data_root: std::path::PathBuf,
        installation: ResolvedInstallation,
        nonce: String,
        owners: ControlOwners,
    ) -> Result<Self, crate::host::HostError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|source| {
                crate::host::HostError::new("gateway_control_bind_failed").with_source(source)
            })?;
        let address = listener.local_addr().map_err(|source| {
            crate::host::HostError::new("gateway_control_bind_failed").with_source(source)
        })?;
        let endpoint = address.to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let shutdown = CancellationToken::new();
        let context = Arc::new(ControlContext {
            data_root,
            installation,
            nonce,
            token: token.clone(),
            lifecycle: owners.lifecycle,
            effects: owners.effects,
            stop: owners.stop,
        });
        let task = tokio::spawn(accept(listener, context, shutdown.clone()));
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

    pub(crate) fn stop_accepting(&self) {
        crate::host::service::shutdown_trace::event("control_cancel_requested");
        self.shutdown.cancel();
    }

    pub(crate) async fn close(mut self) -> Result<(), crate::host::HostError> {
        self.shutdown.cancel();
        let task = self
            .task
            .take()
            .ok_or_else(|| "gateway_control_task_missing".to_owned())?;
        // Cancellation is orderly; abort bounds the pending read independently
        // of its IO timeout if the accept task has not observed cancellation.
        task.abort();
        crate::host::service::shutdown_trace::event("control_abort_requested");
        timeout(IO_TIMEOUT, task)
            .await
            .map_err(|source| {
                crate::host::service::shutdown_trace::event("control_join_timeout");
                crate::host::HostError::new("gateway_control_shutdown_timeout").with_source(source)
            })?
            .or_else(|source| {
                if source.is_cancelled() {
                    Ok(())
                } else {
                    Err(crate::host::HostError::new("gateway_control_task_failed")
                        .with_source(source))
                }
            })
    }
}

/// Serves one connection at a time until `shutdown`.
async fn accept(listener: TcpListener, context: Arc<ControlContext>, shutdown: CancellationToken) {
    loop {
        let accepted = tokio::select! {
            () = shutdown.cancelled() => break,
            value = listener.accept() => value,
        };
        let Ok((mut stream, _peer)) = accepted else {
            continue;
        };
        #[cfg(debug_assertions)]
        shutdown_order::before_wait(&context.data_root, &shutdown).await;
        tokio::select! {
            biased;
            _ = serve_one(&mut stream, &context) => {},
            () = shutdown.cancelled() => {
                crate::host::service::shutdown_trace::event("control_connection_cancelled");
                break;
            },
        }
    }
}

async fn serve_one(
    stream: &mut TcpStream,
    context: &ControlContext,
) -> Result<(), crate::host::HostError> {
    let read = read_frame::<ControlRequest>(stream);
    #[cfg(debug_assertions)]
    let read = shutdown_order::read_started(&context.data_root, read);
    let request = timeout(IO_TIMEOUT, read).await.map_err(|source| {
        crate::host::service::shutdown_trace::event("control_request_timeout");
        crate::host::HostError::new("gateway_control_request_timeout").with_source(source)
    })??;
    let result = if request_is_valid(&request, context) {
        run(&request, context).await
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
    .map_err(|source| {
        crate::host::HostError::new("gateway_control_response_timeout").with_source(source)
    })?
}

/// The request names this instance with its token, and the instance still
/// owns DATA as its record says.
fn request_is_valid(request: &ControlRequest, context: &ControlContext) -> bool {
    request.schema == CONTROL_SCHEMA
        && request.nonce == context.nonce
        && constant_time_equal(request.token.as_bytes(), context.token.as_bytes())
        && validate_write_destinations(&context.data_root, &context.installation).is_ok()
        && instance_is_locked(&context.data_root).unwrap_or(false)
        && read_record(&context.data_root)
            .ok()
            .flatten()
            .is_some_and(|record| {
                state_admits(request.command, &record.state)
                    && record.nonce == context.nonce
                    && record.control_token.as_deref().is_some_and(|stored| {
                        constant_time_equal(stored.as_bytes(), context.token.as_bytes())
                    })
                    && process_matches(&record).unwrap_or(false)
            })
}

/// Commands run while the instance is ready; a stopping instance (its
/// controller marked the record first) still takes its stop and reports a
/// restart handoff.
fn state_admits(command: GatewayControlCommand, state: &str) -> bool {
    state == "ready"
        || (state == "stopping"
            && matches!(
                command,
                GatewayControlCommand::RestartHandoffResult | GatewayControlCommand::ServiceStop
            ))
}

async fn run(request: &ControlRequest, context: &ControlContext) -> Value {
    let command = async {
        match request.command {
            GatewayControlCommand::RestartHandoffResult => {
                record_restart_handoff(request, &context.effects).await
            }
            GatewayControlCommand::ServiceStop => stop_service(request, context),
            command => context.lifecycle.execute(command).await,
        }
    };
    match timeout(COMMAND_TIMEOUT, command).await {
        Err(_) => {
            json!({"ok":false,"error":{"code":"gateway_lifecycle_timeout","message":"Gateway lifecycle command timed out"}})
        }
        Ok(Ok(data)) => json!({"ok":true,"data":data}),
        Ok(Err(message)) => {
            let (code, message) = lifecycle_error_parts(message.message());
            json!({"ok":false,"error":{"code":code,"message":message}})
        }
    }
}

async fn record_restart_handoff(
    request: &ControlRequest,
    effects: &StorageEffectJournal,
) -> Result<Value, crate::host::HostError> {
    let key = request
        .intent_id
        .as_deref()
        .ok_or("restart_handoff_result_invalid")?;
    let state = restart_outcome(request.outcome.as_deref())?;
    effects
        .finish_restart_handoff(key.to_owned(), state)
        .await
        .map_err(|error| format!("{}: journal result could not be recorded", error.code()))?;
    Ok(json!({"recorded":true}))
}

/// `service_stop`: the controller's stop of this instance, delivered where
/// the host has no stop signal (Windows). As with SIGTERM, the controller
/// announced the stop in the DATA stop intent first; the intent id is the
/// instance nonce the intent names.
fn stop_service(
    request: &ControlRequest,
    context: &ControlContext,
) -> Result<Value, crate::host::HostError> {
    let announced = request.intent_id.as_deref() == Some(context.nonce.as_str())
        && stop_announced_for(&context.data_root, std::process::id(), &context.nonce);
    if !announced {
        return Err("service_stop_unannounced: no stop intent names this instance".into());
    }
    (context.stop)();
    Ok(json!({"stopping":true}))
}

fn restart_outcome(value: Option<&str>) -> Result<&'static str, crate::host::HostError> {
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
    record: &crate::host::service::instance::InstanceRecord,
    key: &str,
    outcome: &str,
) -> Result<(), crate::host::HostError> {
    restart_outcome(Some(outcome))?;
    let request = json!({
        "schema":CONTROL_SCHEMA,"nonce":record.nonce,"command":"restart_handoff_result",
        "intent_id":key,"outcome":outcome,
    });
    send(record, request, "restart_handoff_result_failed")
        .await
        .map(|_| ())
}

/// Sends `service_stop` to the instance `record` names, after the caller
/// announced the stop in the DATA stop intent (see [`stop_service`]).
pub(crate) async fn request_service_stop(
    record: &crate::host::service::instance::InstanceRecord,
) -> Result<(), crate::host::HostError> {
    let request = json!({
        "schema":CONTROL_SCHEMA,"nonce":record.nonce,"command":"service_stop",
        "intent_id":record.nonce,
    });
    send(record, request, "service_stop_failed")
        .await
        .map(|_| ())
}

pub(crate) async fn memory_status(
    record: &crate::host::service::instance::InstanceRecord,
) -> Result<Value, crate::host::HostError> {
    let response = send(
        record,
        json!({"schema":CONTROL_SCHEMA, "nonce":record.nonce, "command":"status"}),
        "memory_status_unavailable",
    )
    .await?;
    Ok(response["data"]["memoryModel"].clone())
}

/// Sends `request` (without its token, which comes from `record`) to the
/// loopback control endpoint `record` publishes; a refused command is its
/// error code, or `failed`.
async fn send(
    record: &crate::host::service::instance::InstanceRecord,
    mut request: Value,
    failed: &str,
) -> Result<Value, crate::host::HostError> {
    let endpoint = record
        .control_endpoint
        .as_deref()
        .ok_or("gateway_control_unavailable")?;
    let address: SocketAddr = endpoint.parse().map_err(|source| {
        crate::host::HostError::new("gateway_control_identity_invalid").with_source(source)
    })?;
    if !address.ip().is_loopback() {
        return Err("gateway_control_identity_invalid".into());
    }
    request["token"] = Value::from(
        record
            .control_token
            .as_deref()
            .ok_or("gateway_control_unavailable")?,
    );
    let mut stream = timeout(IO_TIMEOUT, TcpStream::connect(address))
        .await
        .map_err(|source| {
            crate::host::HostError::new("gateway_control_timeout").with_source(source)
        })?
        .map_err(|source| {
            crate::host::HostError::new("gateway_control_unavailable").with_source(source)
        })?;
    timeout(IO_TIMEOUT, write_frame(&mut stream, &request))
        .await
        .map_err(|source| {
            crate::host::HostError::new("gateway_control_timeout").with_source(source)
        })??;
    let response: ControlResponse = timeout(IO_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|source| {
            crate::host::HostError::new("gateway_control_timeout").with_source(source)
        })??;
    if response.schema != CONTROL_SCHEMA || response.result["ok"] != true {
        return Err(response.result["error"]["code"]
            .as_str()
            .unwrap_or(failed)
            .to_owned()
            .into());
    }
    Ok(response.result)
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

async fn read_frame<T: for<'de> Deserialize<'de>>(
    stream: &mut TcpStream,
) -> Result<T, crate::host::HostError> {
    let length = stream.read_u32().await.map_err(|source| {
        crate::host::HostError::new("gateway_control_request_invalid").with_source(source)
    })? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("gateway_control_request_invalid".into());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.map_err(|source| {
        crate::host::HostError::new("gateway_control_request_invalid").with_source(source)
    })?;
    serde_json::from_slice(&bytes).map_err(|source| {
        crate::host::HostError::new("gateway_control_request_invalid").with_source(source)
    })
}

async fn write_frame<T: Serialize>(
    stream: &mut TcpStream,
    value: &T,
) -> Result<(), crate::host::HostError> {
    let bytes = serde_json::to_vec(value).map_err(|source| {
        crate::host::HostError::new("gateway_control_response_invalid").with_source(source)
    })?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err("gateway_control_response_invalid".into());
    }
    stream
        .write_u32(u32::try_from(bytes.len()).unwrap_or(u32::MAX))
        .await
        .map_err(|source| {
            crate::host::HostError::new("gateway_control_response_failed").with_source(source)
        })?;
    stream.write_all(&bytes).await.map_err(|source| {
        crate::host::HostError::new("gateway_control_response_failed").with_source(source)
    })?;
    stream.flush().await.map_err(|source| {
        crate::host::HostError::new("gateway_control_response_failed").with_source(source)
    })
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
