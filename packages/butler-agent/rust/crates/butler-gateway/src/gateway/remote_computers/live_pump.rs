//! Keep one stream open while the remote has runnable work.
use super::{
    HttpError, Link, RemoteStream,
    live::{Connection, LiveRelays},
    live_records::{self, Record},
    relay, sessions,
};
use crate::gateway::GatewayApplication;
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

pub(super) struct Pump {
    pub(super) relays: LiveRelays,
    pub(super) link: Link,
    pub(super) application: Arc<dyn GatewayApplication>,
    pub(super) computer: String,
    pub(super) stop: CancellationToken,
    pub(super) wake: Arc<Notify>,
}

enum Ended {
    Idle,
    Restart,
    Stopped,
    Lost(String),
}

const PERMANENT: [&str; 6] = [
    "host_key_changed",
    "ssh_auth_failed",
    "ssh_client_missing",
    "remote_key_mismatch",
    "computer_not_found",
    "unsupported_computer",
];

pub(super) async fn run(pump: Pump) {
    let mut system_wake = butler_platform::system_wake::wake_events();
    let mut failures: u32 = 0;
    loop {
        let code = match attempt(&pump, &mut system_wake, &mut failures).await {
            Ended::Stopped => return,
            Ended::Idle => {
                super::transcripts::spawn_pull(pump.link.clone(), pump.computer.clone());
                return;
            }
            Ended::Restart => {
                pump.relays
                    .set(&pump.computer, &pump.wake, Connection::Reconnecting, None);
                continue;
            }
            Ended::Lost(code) => code,
        };
        failures += 1;
        let permanent = PERMANENT.contains(&code.as_str());
        let state = if failures >= 3 || permanent {
            Connection::Unreachable
        } else {
            Connection::Reconnecting
        };
        pump.relays
            .set(&pump.computer, &pump.wake, state, Some(code));
        if !wait(&pump, &mut system_wake, &mut failures, permanent).await {
            return;
        }
    }
}

async fn attempt(pump: &Pump, system_wake: &mut watch::Receiver<u64>, failures: &mut u32) -> Ended {
    let cursor = pump.relays.cursor(&pump.computer);
    let path = format!("/events/live?cursor={}", cursor.unwrap_or(0));
    let stream = tokio::select! {
        biased;
        () = pump.stop.cancelled() => return Ended::Stopped,
        result = sessions::open_stream(&pump.link, &pump.computer, &path) => result,
    };
    match stream {
        Ok(stream) if stream.status == 200 => {
            *failures = 0;
            pump.relays
                .set(&pump.computer, &pump.wake, Connection::Connected, None);
            super::pending::pull_from_pump(pump);
            read(pump, system_wake, stream, cursor.is_none()).await
        }
        Ok(_) => Ended::Lost("remote_request_failed".into()),
        Err(HttpError::Public { code, .. }) => Ended::Lost(code),
        Err(_) => Ended::Lost("remote_unavailable".into()),
    }
}

async fn wait(
    pump: &Pump,
    system_wake: &mut watch::Receiver<u64>,
    failures: &mut u32,
    permanent: bool,
) -> bool {
    let delay = Duration::from_secs((1u64 << (*failures - 1).min(6)).min(60));
    tokio::select! {
        biased;
        () = pump.stop.cancelled() => return false,
        () = pump.wake.notified() => *failures = 0,
        Ok(()) = system_wake.changed() => *failures = 0,
        () = tokio::time::sleep(delay), if !permanent => {}
    }
    true
}

async fn read(
    pump: &Pump,
    system_wake: &mut watch::Receiver<u64>,
    mut stream: RemoteStream,
    history: bool,
) -> Ended {
    let mut caught_up = false;
    let mut bound = HashSet::new();
    loop {
        let record = tokio::select! {
            biased;
            () = pump.stop.cancelled() => return Ended::Stopped,
            () = pump.wake.notified() => return Ended::Restart,
            Ok(()) = system_wake.changed() => return Ended::Restart,
            result = tokio::time::timeout(Duration::from_secs(45), live_records::next(&mut stream.body)) => match result {
                Ok(Ok(Some(record))) => record,
                Ok(Ok(None)) => return Ended::Lost("remote_stream_ended".into()),
                Ok(Err(_)) => return Ended::Lost("remote_stream_invalid".into()),
                Err(_) => return Ended::Lost("remote_stream_silent".into()),
            },
        };
        if record.event.as_deref() == Some("heartbeat") {
            if !caught_up {
                caught_up = true;
                if history {
                    pump.relays.emit(live_records::reconcile(&pump.computer));
                }
                if let Some(end) = settle(pump, &mut bound).await {
                    return end;
                }
            }
            continue;
        }
        if let Some(request) = super::memory::requested(&record) {
            super::memory::answer(pump, request);
            continue;
        }
        if super::pending::woken(&record) {
            super::pending::pull_from_pump(pump);
            continue;
        }
        if !history || caught_up || record.id.is_none() {
            live_records::forward(
                &pump.relays,
                &*pump.application,
                &pump.computer,
                &record,
                &mut bound,
            )
            .await;
        }
        if let Some(id) = record.id {
            pump.relays.set_cursor(&pump.computer, &pump.wake, id);
        }
        if caught_up
            && live_records::settles_turn(&record)
            && let Some(end) = settle(pump, &mut bound).await
        {
            return end;
        }
    }
}

async fn settle(pump: &Pump, bound: &mut HashSet<String>) -> Option<Ended> {
    let get = async |path: &str| {
        let result = tokio::select! {
            biased;
            () = pump.stop.cancelled() => return Err(Ended::Stopped),
            reply = sessions::forward(&pump.link, &pump.computer, "GET", path, Vec::new()) => reply,
        };
        result.and_then(relay::data).map_err(|error| match error {
            HttpError::Public { code, .. } => Ended::Lost(code),
            _ => Ended::Lost("remote_unavailable".into()),
        })
    };
    loop {
        let Some(seen) = pump.relays.demand(&pump.computer, &pump.wake) else {
            return Some(Ended::Stopped);
        };
        let data = match get("/user-work").await {
            Ok(data) => data,
            Err(end) => return Some(end),
        };
        if data["runnable_turn_count"] != 0
            || data["runnable_queued_count"] != 0
            || data["delegated_work_present"] == true
        {
            return None;
        }
        loop {
            let cursor = pump.relays.cursor(&pump.computer).unwrap_or(0);
            let path = format!("/events?cursor={cursor}&limit=200");
            let page = match get(&path).await {
                Ok(page) => page,
                Err(end) => return Some(end),
            };
            let Some(events) = page["events"].as_array() else {
                return Some(Ended::Lost("remote_stream_invalid".into()));
            };
            for event in events {
                let Some(id) = event["id"].as_u64() else {
                    return Some(Ended::Lost("remote_stream_invalid".into()));
                };
                let record = Record {
                    id: Some(id),
                    event: None,
                    data: event.to_string(),
                    oversized: false,
                };
                live_records::forward(
                    &pump.relays,
                    &*pump.application,
                    &pump.computer,
                    &record,
                    bound,
                )
                .await;
                pump.relays.set_cursor(&pump.computer, &pump.wake, id);
            }
            if events.len() < 200 {
                break;
            }
        }
        if pump.relays.finish(&pump.computer, &pump.wake, seen) {
            return Some(Ended::Idle);
        }
    }
}
