use super::{Mail, Result, imap, message, state::Cursor};
use async_imap::types::UnsolicitedResponse;
use imap_proto::{MailboxDatum, Response};
use rmcp::{Peer, RoleServer, model::ResourceUpdatedNotificationParam};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    mail: Arc<Mail>,
    peer: Peer<RoleServer>,
    stop: CancellationToken,
    auth_failed: CancellationToken,
) {
    let mut delay = 1;
    loop {
        let result = tokio::select! { ()=stop.cancelled()=>return, r=connected(&mail, &peer, &auth_failed, &mut delay)=>r };
        if let Err(
            code @ ("mail_auth_failed" | "mail_idle_unsupported" | "mail_server_unsupported"),
        ) = result
        {
            *mail.terminal.lock().await = Some(code);
            auth_failed.cancel();
            return;
        }
        tokio::select! { ()=stop.cancelled()=>return, ()=tokio::time::sleep(Duration::from_secs(delay))=>() }
        delay = (delay * 2).min(60);
    }
}
async fn connected(
    mail: &Mail,
    peer: &Peer<RoleServer>,
    auth_failed: &CancellationToken,
    delay: &mut u64,
) -> Result<()> {
    let (mut connection, inbox) = mail.connect(Some(auth_failed)).await?;
    let inbox = inbox.ok_or("mail_server_unsupported")?;
    let validity = inbox.uid_validity.ok_or("mail_server_unsupported")?;
    let next = inbox.uid_next.ok_or("mail_server_unsupported")?;
    let mut cursor = baseline(mail, validity, next).await?;
    // Catch up once on reconnect. There are no timer-driven SEARCH/FETCH calls.
    mail.bounded(deliver(mail, peer, &mut connection, &mut cursor))
        .await?;
    loop {
        if idle(&mut connection, mail.config.timeout, delay).await? {
            mail.bounded(deliver(mail, peer, &mut connection, &mut cursor))
                .await?;
        }
    }
}
async fn idle(
    connection: &mut imap::Connection,
    timeout: Duration,
    delay: &mut u64,
) -> Result<bool> {
    let (tag, mut changed) = tokio::time::timeout(timeout, enter_idle(connection))
        .await
        .map_err(|_| "mail_operation_timeout")??;
    *delay = 1;
    let deadline = tokio::time::Instant::now() + Duration::from_mins(26);
    while !changed {
        let response = match tokio::time::timeout_at(deadline, connection.read_response()).await {
            Err(_) => break,
            Ok(result) => result
                .map_err(|_| "mail_idle_failed")?
                .ok_or("mail_idle_closed")?,
        };
        match response.parsed() {
            Response::MailboxData(MailboxDatum::Exists(_)) => changed = true,
            Response::Data {
                status: imap_proto::Status::Bye,
                ..
            }
            | Response::Done { .. } => return Err("mail_idle_closed"),
            _ => (),
        }
    }
    tokio::time::timeout(timeout, leave_idle(connection, &tag, changed))
        .await
        .map_err(|_| "mail_operation_timeout")?
}
async fn enter_idle(connection: &mut imap::Connection) -> Result<(imap_proto::RequestId, bool)> {
    let tag = connection
        .run_command("IDLE")
        .await
        .map_err(|_| "mail_idle_failed")?;
    let mut changed = false;
    while let Ok(response) = connection.unsolicited_responses.try_recv() {
        changed |= matches!(response, UnsolicitedResponse::Exists(_));
    }
    loop {
        let response = connection
            .read_response()
            .await
            .map_err(|_| "mail_idle_failed")?
            .ok_or("mail_idle_closed")?;
        match response.parsed() {
            Response::Continue { .. } => break,
            Response::MailboxData(MailboxDatum::Exists(_)) => changed = true,
            Response::Done { .. } => return Err("mail_idle_refused"),
            _ => (),
        }
    }
    Ok((tag, changed))
}
async fn leave_idle(
    connection: &mut imap::Connection,
    tag: &imap_proto::RequestId,
    mut changed: bool,
) -> Result<bool> {
    connection
        .run_command_untagged("DONE")
        .await
        .map_err(|_| "mail_idle_failed")?;
    loop {
        let response = connection
            .read_response()
            .await
            .map_err(|_| "mail_idle_failed")?
            .ok_or("mail_idle_closed")?;
        match response.parsed() {
            Response::Done {
                tag: received,
                status: imap_proto::Status::Ok,
                ..
            } if received == tag => return Ok(changed),
            Response::Done { .. } => return Err("mail_idle_failed"),
            Response::MailboxData(MailboxDatum::Exists(_)) => changed = true,
            _ => (),
        }
    }
}
async fn baseline(mail: &Mail, validity: u32, next: u32) -> Result<Cursor> {
    let mut state = mail.state.lock().await;
    if let Some(cursor) = &state.cursor
        && cursor.validity == validity
    {
        return Ok(state
            .pending
            .last()
            .map(|(_, c)| c)
            .unwrap_or(cursor)
            .clone());
    }
    let cursor = Cursor {
        validity,
        last: next.saturating_sub(1),
    };
    state.cursor = Some(cursor.clone());
    state.pending.clear();
    // Persist the initial high-water mark too, so wake catch-up works before any arrival.
    state.save(&mail.config.data).await?;
    Ok(cursor)
}
async fn deliver(
    mail: &Mail,
    peer: &Peer<RoleServer>,
    connection: &mut imap::Connection,
    cursor: &mut Cursor,
) -> Result<()> {
    let start = cursor.last.checked_add(1).ok_or("mail_uid_overflow")?;
    let mut uids = connection
        .uid_search(format!("UID {start}:*"))
        .await
        .map_err(|_| "mail_search_failed")?
        .into_iter()
        .filter(|uid| *uid > cursor.last)
        .collect::<Vec<_>>();
    uids.sort_unstable();
    for uid in uids {
        let fetch = imap::fetch(connection, uid, false).await?;
        let id = message::Id {
            mailbox: "INBOX".into(),
            validity: cursor.validity,
            uid,
        };
        let mut event = message::event(&fetch, &id, &mail.config.address)?;
        cursor.last = uid;
        let mut state = mail.state.lock().await;
        state.moved = super::state::State::moved(&mail.config.data).await?;
        if state.moved.iter().any(|key| event["dedupe_key"] == *key) {
            event["signal"] = serde_json::json!({"type":"returned","ref":event["dedupe_key"]});
        }
        // Durable pending rows survive reads and restarts until the host acknowledges.
        if !state.pending.iter().any(|(v, _)| v["id"] == event["id"]) {
            state.pending.push((event, cursor.clone()));
        }
    }
    // EXISTS can be consumed during SEARCH/FETCH; process that change before sleeping.
    let mut again = false;
    while let Ok(response) = connection.unsolicited_responses.try_recv() {
        again |= matches!(response, UnsolicitedResponse::Exists(_));
    }
    let state = mail.state.lock().await;
    let pending = !state.pending.is_empty();
    if pending {
        state.save(&mail.config.data).await?;
    }
    drop(state);
    if pending {
        peer.notify_resource_updated(ResourceUpdatedNotificationParam::new("connector://events"))
            .await
            .map_err(|_| "mail_notify_failed")?;
    }
    if again {
        return Box::pin(deliver(mail, peer, connection, cursor)).await;
    }
    Ok(())
}
