//! Conversations that run on a registered computer, reached only through its socket.
use super::{AppSetupPort, Computer, HttpError, connect, list, locked, relay, remote_error};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(in crate::gateway) struct Link {
    pub setup: Arc<dyn AppSetupPort>,
    pub root: PathBuf,
    pub version: String,
    pub cancel: CancellationToken,
}

pub(in crate::gateway) async fn create_session(
    link: &Link,
    computer_id: &str,
    session_id: &str,
    title: Option<&str>,
) -> Result<(), HttpError> {
    let computer = find(link, computer_id).await?;
    let body = json!({"session_id": session_id, "folder": computer.folder, "title": title})
        .to_string()
        .into_bytes();
    relay::data(send(link, &computer, "POST", "/remote/sessions", body).await?).map(drop)
}

pub(in crate::gateway) async fn forward(
    link: &Link,
    computer_id: &str,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> Result<relay::Reply, HttpError> {
    let computer = find(link, computer_id).await?;
    let reply = send(link, &computer, method, path, body).await?;
    if reply.status == 401 {
        return Err(remote_error(
            "remote_request_failed",
            "The computer refused the request.",
        ));
    }
    Ok(reply)
}

async fn send(
    link: &Link,
    computer: &Computer,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> Result<relay::Reply, HttpError> {
    match relay::send(computer, method, path, body.clone(), link.cancel.clone()).await? {
        relay::Sent::Reply(reply) => Ok(reply),
        relay::Sent::NotRunning => {
            let (_lock, computer) = locked(&link.root, &computer.id).await?;
            connect(
                &link.setup,
                &link.root,
                &link.version,
                &computer,
                link.cancel.clone(),
            )
            .await?;
            relay::request(&computer, method, path, body, link.cancel.clone()).await
        }
    }
}

async fn find(link: &Link, id: &str) -> Result<Computer, HttpError> {
    list(&link.root)
        .await?
        .into_iter()
        .find(|computer| computer.id == id)
        .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))
}
