//! Pull finished turns through the computer's change-log cursor.
use super::{Link, list, streams};
use crate::gateway::GatewayApplicationError;
use butler_core::configuration::write_json_atomic;
use butler_turn::conversation::TransferMark;
use parking_lot::Mutex;
use serde::Deserialize;
use std::{collections::HashMap, io, path::Path, sync::LazyLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

static PULLS: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Mutex::default);

pub(super) fn spawn_pull(link: Link, computer_id: String) {
    {
        let mut pulls = PULLS.lock();
        if let Some(rerun) = pulls.get_mut(&computer_id) {
            *rerun = true;
            return;
        }
        pulls.insert(computer_id.clone(), false);
    }
    tokio::spawn(async move {
        loop {
            if let Err(reason) = pull(&link, &computer_id).await {
                butler_core::diagnostic!(
                    "[remote-transcripts] stopped computer={computer_id} reason={reason}"
                );
            }
            let mut pulls = PULLS.lock();
            if pulls.get_mut(&computer_id).is_some_and(std::mem::take) {
                continue;
            }
            pulls.remove(&computer_id);
            return;
        }
    });
}

#[derive(Deserialize)]
struct Cursor {
    version: u64,
    mark: TransferMark,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct End {
    end: TransferMark,
}

async fn request_path(cursor: &Path) -> Result<String, &'static str> {
    let path = "/remote/transcripts";
    let bytes = match tokio::fs::read(cursor).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(path.to_owned()),
        Err(_) => return Err("cursor_read"),
    };
    let Cursor { version, mark } = serde_json::from_slice(&bytes).map_err(|_| "cursor_read")?;
    if version != 1 {
        return Err("cursor_read");
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("identity", mark.identity.as_deref().unwrap_or_default())
        .append_pair("seq", &mark.seq.to_string())
        .append_pair("key", &mark.key)
        .finish();
    Ok(format!("{path}?{query}"))
}

async fn pull(link: &Link, computer_id: &str) -> Result<(), &'static str> {
    let computer = list(&link.root)
        .await
        .map_err(|_| "computer_list")?
        .into_iter()
        .find(|computer| computer.id == computer_id)
        .ok_or("computer_missing")?;
    let cursor = link
        .root
        .join("config/computers")
        .join(format!("{computer_id}.transcripts.json"));
    let path = request_path(&cursor).await?;
    let streams::Opened::Stream(mut stream) = streams::open(&computer, &path, link.cancel.clone())
        .await
        .map_err(|_| "stream_open")?
    else {
        return Err("not_running");
    };
    if stream.status != 200 {
        return Err("stream_status");
    }
    let mark = loop {
        let mut line = Vec::new();
        let mut limited = (&mut stream.body).take(64 * 1024 * 1024);
        tokio::select! {
            () = link.cancel.cancelled() => return Err("cancelled"),
            result = limited.read_until(b'\n', &mut line) => { result.map_err(|_| "stream_read")?; }
        }
        if !line.ends_with(b"\n") {
            return Err("incomplete_stream");
        }
        if let Ok(End { end }) = serde_json::from_slice(&line) {
            if end.identity.as_ref().is_some_and(|s| s.len() > 512) || end.key.len() > 512 {
                return Err("invalid_end");
            }
            break end;
        }
        match link
            .setup
            .computer_import_turn(computer_id.to_owned(), line)
            .await
        {
            Ok(_) => (),
            Err(GatewayApplicationError::Public { code, .. }) if code == "transfer_skipped" => {
                butler_core::diagnostic!(
                    "[remote-transcripts] skipped computer={computer_id} reason={code}"
                );
            }
            Err(_) => return Err("import_failed"),
        }
    };
    tokio::task::spawn_blocking(move || {
        write_json_atomic(&cursor, &serde_json::json!({"version":1, "mark":mark}))
    })
    .await
    .map_err(|_| "cursor_write")?
    .map_err(|_| "cursor_write")
}
