//! Decode a remote SSE record and relay only events for conversations bound here.
use super::live::LiveRelays;
use crate::gateway::{
    AppEventEnvelope, GatewayApplication, GatewaySessionControls, TurnState,
    event_kinds::{self, Scope},
    protocol::APP_PROTOCOL_VERSION,
};
use butler_platform::hook_process::StreamingProcess;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::{collections::HashSet, io, time::SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

pub(super) struct Record {
    pub(super) id: Option<u64>,
    pub(super) event: Option<String>,
    pub(super) data: String,
    pub(super) oversized: bool,
}

pub(super) async fn next(body: &mut BufReader<StreamingProcess>) -> io::Result<Option<Record>> {
    const LIMIT: usize = 16 * 1024 * 1024;
    let mut record = Record {
        id: None,
        event: None,
        data: String::new(),
        oversized: false,
    };
    let mut size = 0;
    let mut has_data = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = (&mut *body)
            .take(LIMIT as u64 + 1)
            .read_until(b'\n', &mut line)
            .await?;
        if n == 0 {
            return Ok(None);
        }
        if line == b"\n" || line == b"\r\n" {
            return Ok(Some(record));
        }
        size += n;
        if size > LIMIT {
            record.oversized = true;
            while !line.ends_with(b"\n") {
                line.clear();
                if (&mut *body)
                    .take(64 * 1024)
                    .read_until(b'\n', &mut line)
                    .await?
                    == 0
                {
                    return Ok(None);
                }
            }
            continue;
        }
        let line = std::str::from_utf8(&line)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let Some((name, value)) = line.trim_end_matches(['\r', '\n']).split_once(':') else {
            continue;
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match name {
            "id" => record.id = value.parse().ok(),
            "event" => record.event = Some(value.to_owned()),
            "data" => {
                if has_data {
                    record.data.push('\n');
                }
                record.data.push_str(value);
                has_data = true;
            }
            _ => {}
        }
    }
}

pub(super) async fn forward(
    relays: &LiveRelays,
    application: &dyn GatewayApplication,
    computer: &str,
    record: &Record,
    bound: &mut HashSet<String>,
) -> bool {
    if record.oversized {
        relays.emit(reconcile(computer));
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(&record.data) else {
        return false;
    };
    let Some(kind) = value["type"].as_str() else {
        return false;
    };
    let payload = &value["payload"];
    let is_bound = async |id: &str, bound: &mut HashSet<String>| {
        if bound.contains(id) {
            return true;
        }
        if matches!(GatewaySessionControls::session_computer(application, id.to_owned()).await, Ok(Some(c)) if c == computer)
        {
            bound.insert(id.to_owned());
            return true;
        }
        false
    };
    let emit = |kind: &str, payload: Map<String, Value>| {
        relays.emit(AppEventEnvelope {
            id: 0,
            protocol_version: APP_PROTOCOL_VERSION.to_owned(),
            event_type: kind.to_owned(),
            created_at: value["created_at"].as_str().unwrap_or_default().to_owned(),
            payload,
        });
    };
    match event_kinds::scope(kind) {
        None | Some(Scope::Local) => {}
        Some(Scope::Reconcile) => relays.emit(reconcile(computer)),
        Some(Scope::Snapshot) => {
            if let Some(drafts) = payload["drafts"].as_array() {
                for draft in drafts {
                    if let Some(object) = draft.as_object()
                        && let Some(id) = draft["session_id"].as_str()
                        && is_bound(id, bound).await
                    {
                        emit("answer_blocks.draft", object.clone());
                    }
                }
            }
        }
        Some(Scope::Session) => {
            let id = if matches!(
                kind,
                "agent.turn_event" | "agent.turn_event.progress" | "progress.summary"
            ) {
                payload["session_id"].as_str()
            } else {
                payload["chat_id"]
                    .as_str()
                    .or_else(|| payload["session_id"].as_str())
                    .or_else(|| payload["turn"]["chat_id"].as_str())
                    .or_else(|| payload["message"]["chat_id"].as_str())
            };
            if let Some(id) = id
                && is_bound(id, bound).await
            {
                emit(kind, payload.as_object().cloned().unwrap_or_default());
                return kind == "turn.state_changed";
            }
        }
    }
    false
}

pub(super) fn reconcile(computer: &str) -> AppEventEnvelope {
    AppEventEnvelope {
        id: 0,
        protocol_version: APP_PROTOCOL_VERSION.to_owned(),
        event_type: "stream.reconcile_required".to_owned(),
        created_at: butler_core::js_date::iso_from_system_time(SystemTime::now()),
        payload: Map::from_iter([("computer_id".to_owned(), computer.into())]),
    }
}

pub(super) fn settles_turn(record: &Record) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(&record.data) else {
        return false;
    };
    if value["type"] != "turn.state_changed" {
        return false;
    }
    let payload = &value["payload"];
    let view = if payload["turn"].is_object() {
        &payload["turn"]
    } else {
        payload
    };
    TurnState::deserialize(&view["state"]).is_ok_and(|state| match state {
        TurnState::WaitingForForm
        | TurnState::Cancelled
        | TurnState::Delivered
        | TurnState::RuntimeFault
        | TurnState::Failed => true,
        TurnState::Queued
        | TurnState::Accepted
        | TurnState::Thinking
        | TurnState::Streaming
        | TurnState::WaitingForTool
        | TurnState::Cancelling
        | TurnState::Retrying => false,
    })
}

pub(in crate::gateway) fn names_running_turn(body: &Value) -> bool {
    let data = &body["data"];
    let running =
        |turn: &Value| TurnState::deserialize(&turn["state"]).is_ok_and(|state| !ends(&state));
    data["active_turn"].is_object()
        || running(&data["latest_turn"])
        || data["turns"]
            .as_array()
            .is_some_and(|turns| turns.iter().any(running))
}

fn ends(state: &TurnState) -> bool {
    match state {
        TurnState::Queued
        | TurnState::Accepted
        | TurnState::Thinking
        | TurnState::Streaming
        | TurnState::WaitingForForm
        | TurnState::WaitingForTool
        | TurnState::Cancelling
        | TurnState::Retrying => false,
        TurnState::Cancelled
        | TurnState::Delivered
        | TurnState::RuntimeFault
        | TurnState::Failed => true,
    }
}
