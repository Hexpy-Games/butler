//! The main's side of a computer's memory: a read-only copy of its
//! instructions and profile, handed over on every connect.
use super::{
    AppSetupPort, Computer, HttpError, live_pump::Pump, live_records::Record, relay, remote_error,
    sessions,
};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn push_copy(
    setup: &Arc<dyn AppSetupPort>,
    computer: &Computer,
    root: &std::path::Path,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let lock = super::pending::PULLS
        .lock()
        .entry(computer.id.clone())
        .or_default()
        .clone();
    let _pull = lock.lock().await;
    let mut copy = setup.computer_memory_copy().await?;
    copy["pending_ids"] = serde_json::json!(super::pending::ids_for(root, &computer.id).await);
    let reply = relay::request(
        computer,
        "POST",
        "/remote/memory",
        copy.to_string().into_bytes(),
        cancel,
    )
    .await?;
    if reply.status == 204 {
        return Ok(());
    }
    Err(remote_error(
        "remote_memory_copy_failed",
        "Could not hand this computer its memory copy.",
    ))
}

/// A memory read a computer waits on, from an id-less frame of its live stream.
pub(super) fn requested(record: &Record) -> Option<Value> {
    if record.id.is_some() {
        return None;
    }
    let mut value: Value = serde_json::from_str(&record.data).ok()?;
    if value["type"] != "memory.read_requested" {
        return None;
    }
    value.get_mut("payload").map(Value::take)
}

/// Answers it from the main's memory with a forwarded write; the computer never contacts the main.
pub(super) fn answer(pump: &Pump, request: Value) {
    let link = pump.link.clone();
    let computer = pump.computer.clone();
    tokio::spawn(async move {
        let Ok(reply) = link.setup.computer_memory_read(request).await else {
            butler_core::diagnostic!("[remote-memory] read failed computer={computer}");
            return;
        };
        let body = reply.to_string().into_bytes();
        let sent =
            sessions::forward(&link, &computer, "POST", "/remote/memory/answers", body).await;
        if !matches!(&sent, Ok(reply) if reply.status == 204) {
            butler_core::diagnostic!("[remote-memory] answer not delivered computer={computer}");
        }
    });
}
