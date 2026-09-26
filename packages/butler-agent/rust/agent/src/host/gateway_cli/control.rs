//! Identity-checked client for the private same-DATA gateway control endpoint.

use std::{net::SocketAddr, path::Path, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};

use crate::host::{
    ResolvedInstallation,
    service_instance::{InstanceRecord, instance_is_locked, process_matches, read_record},
};

const CONTROL_SCHEMA: &str = "butler.native-app-gateway-control.v1";
const MAX_FRAME_BYTES: usize = 8 * 1024;

pub(super) fn verified_instance(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<Option<InstanceRecord>, String> {
    let locked = instance_is_locked(data_root)?;
    let record = read_record(data_root)?;
    match (locked, record) {
        (false, None) => Ok(None),
        (false, Some(record)) => {
            if process_matches(&record)? {
                Err("native_service_instance_ambiguous: live record has no DATA lock".into())
            } else {
                Ok(None)
            }
        }
        (true, Some(record)) => {
            if !matches!(record.state.as_str(), "starting" | "ready" | "stopping")
                || !process_matches(&record)?
            {
                return Err(
                    "native_service_instance_ambiguous: lock owner does not match its record"
                        .into(),
                );
            }
            let executable = std::env::current_exe()
                .map_err(|_| "native_service_executable_unavailable".to_owned())?
                .canonicalize()
                .map_err(|_| "native_service_executable_unavailable".to_owned())?;
            if !executable.starts_with(installation.root())
                || executable.to_string_lossy() != record.executable
            {
                return Err("native_service_instance_executable_mismatch".into());
            }
            Ok(Some(record))
        }
        (true, None) => Err("native_service_instance_ambiguous: DATA lock has no record".into()),
    }
}

pub(super) async fn request(record: &InstanceRecord, command: &str) -> Result<Value, String> {
    if record.state != "ready" {
        return Err("native_service_not_ready".into());
    }
    let endpoint = record
        .control_endpoint
        .as_deref()
        .ok_or_else(|| "gateway_control_unavailable".to_owned())?;
    let address = endpoint
        .parse::<SocketAddr>()
        .map_err(|_| "gateway_control_identity_invalid".to_owned())?;
    if !address.ip().is_loopback() {
        return Err("gateway_control_identity_invalid".into());
    }
    let token = record
        .control_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "gateway_control_unavailable".to_owned())?;
    let command = match command {
        "status" | "test" | "start" | "stop" | "restart" => command,
        _ => return Err("gateway_command_invalid".into()),
    };
    let payload = serde_json::to_vec(&json!({
        "schema":CONTROL_SCHEMA,
        "nonce":record.nonce,
        "token":token,
        "command":command,
    }))
    .map_err(|_| "gateway_control_request_invalid".to_owned())?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err("gateway_control_request_invalid".into());
    }
    let response = timeout(Duration::from_secs(100), async {
        let mut stream = TcpStream::connect(address)
            .await
            .map_err(|_| "gateway_control_unavailable".to_owned())?;
        stream
            .write_u32(payload.len() as u32)
            .await
            .map_err(|_| "gateway_control_request_failed".to_owned())?;
        stream
            .write_all(&payload)
            .await
            .map_err(|_| "gateway_control_request_failed".to_owned())?;
        stream
            .flush()
            .await
            .map_err(|_| "gateway_control_request_failed".to_owned())?;
        let length = stream
            .read_u32()
            .await
            .map_err(|_| "gateway_control_response_invalid".to_owned())?
            as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err("gateway_control_response_invalid".into());
        }
        let mut bytes = vec![0; length];
        stream
            .read_exact(&mut bytes)
            .await
            .map_err(|_| "gateway_control_response_invalid".to_owned())?;
        let outer: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "gateway_control_response_invalid".to_owned())?;
        if outer["schema"] != CONTROL_SCHEMA {
            return Err("gateway_control_response_invalid".into());
        }
        let result = outer
            .get("result")
            .cloned()
            .ok_or_else(|| "gateway_control_response_invalid".to_owned())?;
        if result["ok"] != true {
            let code = result["error"]["code"]
                .as_str()
                .unwrap_or("gateway_lifecycle_failed");
            let message = result["error"]["message"]
                .as_str()
                .unwrap_or("Gateway lifecycle command failed");
            return Err(format!("{code}: {message}"));
        }
        result
            .get("data")
            .cloned()
            .ok_or_else(|| "gateway_control_response_invalid".to_owned())
    })
    .await
    .map_err(|_| "gateway_control_timeout".to_owned())??;
    Ok(response)
}
