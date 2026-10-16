//! Ephemeral preview registry: command identity, agent budget, ports and tree lifetime.
use butler_platform::preview_process::PreviewProcess;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

// A failed background receipt may be consumed once by HTTP, then expires.
const FAILED_RECEIPT_TTL: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Previews {
    entries: Mutex<HashMap<String, Arc<Preview>>>,
    closed: Mutex<HashSet<String>>,
    generations: Mutex<HashMap<String, u64>>,
    starts: tokio::sync::Mutex<()>,
}
struct Preview {
    session: String,
    agent: String,
    command: String,
    cwd: PathBuf,
    port: u16,
    process: PreviewProcess,
    created_at: String,
    failure_reported: AtomicBool,
}
#[derive(Clone)]
pub struct Target {
    pub port: u16,
    pub cancel: CancellationToken,
}
struct Start<'a> {
    session: &'a str,
    agent: &'a str,
    id: &'a str,
    command: &'a str,
    cwd: PathBuf,
    port: u16,
    generation: u64,
}
impl Previews {
    pub async fn start(
        &self,
        session: &str,
        agent: &str,
        id: &str,
        args: &Value,
    ) -> Result<Value, &'static str> {
        let start = self.starts.lock().await;
        let input = Start {
            session,
            agent,
            id,
            command: args["command"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
                .ok_or("invalid_command")?,
            cwd: PathBuf::from(args["cwd"].as_str().ok_or("invalid_cwd")?),
            port: args["port"]
                .as_u64()
                .filter(|p| (1024..=65535).contains(p))
                .and_then(|p| u16::try_from(p).ok())
                .ok_or("invalid_port")?,
            generation: self
                .generations
                .lock()
                .map_err(|_| "preview_unavailable")?
                .get(session)
                .copied()
                .unwrap_or_default(),
        };
        if let Some(existing) = self.admit(&input)? {
            return Ok(existing);
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", input.port))
            .await
            .is_ok()
        {
            return Err("port_in_use");
        }
        let process = PreviewProcess::start(input.command.into(), input.cwd.clone())
            .await
            .map_err(|_| "preview_spawn_failed")?;
        if let Err((reason, process)) = self.register(input, process) {
            drop(start);
            process.stop().await.map_err(|_| "preview_stop_failed")?;
            return Err(reason);
        }
        drop(start); // Readiness must not block another agent's start or archive.
        let target = self.target(id);
        if !match target {
            Some(target) => ready(&target).await,
            None => false,
        } {
            let _ = self.stop(session, agent, id).await;
            return Err("preview_not_ready");
        }
        self.entries
            .lock()
            .map_err(|_| "preview_unavailable")?
            .get(id)
            .map(|entry| summary(id, entry))
            .ok_or("session_closed")
    }
    fn admit(&self, input: &Start<'_>) -> Result<Option<Value>, &'static str> {
        if self
            .closed
            .lock()
            .map_err(|_| "preview_unavailable")?
            .contains(input.session)
        {
            return Err("session_closed");
        }
        let entries = self.entries.lock().map_err(|_| "preview_unavailable")?;
        if let Some(entry) = entries.get(input.id) {
            if entry.session == input.session
                && entry.agent == input.agent
                && entry.command == input.command
                && entry.cwd == input.cwd
                && entry.port == input.port
            {
                return if entry.process.is_running() {
                    Ok(Some(summary(input.id, entry)))
                } else {
                    Err("preview_exited")
                };
            }
            return Err("preview_identity_conflict");
        }
        if entries
            .values()
            .filter(|e| e.agent == input.agent && e.process.is_running())
            .count()
            >= 2
        {
            return Err("preview_budget_exhausted");
        }
        if entries
            .values()
            .any(|e| e.port == input.port && e.process.is_running())
        {
            return Err("port_registered");
        }
        Ok(None)
    }
    fn register(
        &self,
        input: Start<'_>,
        process: PreviewProcess,
    ) -> Result<(), (&'static str, PreviewProcess)> {
        let Ok(closed) = self.closed.lock() else {
            return Err(("preview_unavailable", process));
        };
        let Ok(generations) = self.generations.lock() else {
            return Err(("preview_unavailable", process));
        };
        if closed.contains(input.session)
            || generations.get(input.session).copied().unwrap_or_default() != input.generation
        {
            return Err(("session_closed", process));
        }
        let Ok(mut entries) = self.entries.lock() else {
            return Err(("preview_unavailable", process));
        };
        let entry = Preview {
            session: input.session.into(),
            agent: input.agent.into(),
            command: input.command.into(),
            cwd: input.cwd,
            port: input.port,
            process,
            created_at: chrono::Utc::now().to_rfc3339(),
            failure_reported: AtomicBool::new(false),
        };
        entries.insert(input.id.into(), Arc::new(entry));
        Ok(())
    }
    pub fn target(&self, id: &str) -> Option<Target> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(id)?;
        (entry.process.is_running() && !entry.process.cancellation().is_cancelled()).then(|| {
            Target {
                port: entry.port,
                cancel: entry.process.cancellation(),
            }
        })
    }
    pub fn has_active(&self, session: &str) -> bool {
        self.entries.lock().is_ok_and(|entries| {
            entries
                .values()
                .any(|e| e.session == session && e.process.is_running())
        })
    }
    pub fn owned(&self, session: &str, id: &str) -> bool {
        self.entries.lock().is_ok_and(|entries| {
            entries
                .get(id)
                .is_some_and(|e| e.session == session && e.process.is_running())
        })
    }
    pub fn artifacts(&self, session: &str) -> Vec<Value> {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|(_, e)| e.session == session && e.process.is_running())
                    .map(|(id, e)| {
                        json!({
                            "id": id,
                            "session_id": session,
                            "kind": "web",
                            "title": "미리보기",
                            "url": format!("/previews/{id}/view"),
                            "created_at": e.created_at,
                            "open_action": "route"
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    pub async fn stop(&self, session: &str, agent: &str, id: &str) -> Result<Value, &'static str> {
        let entry = self
            .entries
            .lock()
            .map_err(|_| "preview_unavailable")?
            .get(id)
            .filter(|e| e.session == session && e.agent == agent)
            .cloned()
            .ok_or("not_your_preview")?;
        let log = entry.process.log();
        self.stop_entry(id, &entry, true).await?;
        Ok(json!({"status":"ok","preview_id":id,"untrusted_log":log}))
    }
    async fn stop_entry(
        &self,
        id: &str,
        entry: &Arc<Preview>,
        report: bool,
    ) -> Result<(), &'static str> {
        let failed = entry.process.stop().await.is_err();
        if failed && !report {
            // An event can finish before its HTTP lifecycle caller arrives.
            // Keep that receipt briefly; never cache a failure for the session's lifetime.
            tokio::time::sleep(FAILED_RECEIPT_TTL).await;
        }
        let first_failure =
            failed && report && !entry.failure_reported.swap(true, Ordering::AcqRel);
        let mut entries = self.entries.lock().map_err(|_| "preview_unavailable")?;
        if entries
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, entry))
        {
            entries.remove(id);
        }
        // The platform supervisor retains cleanup ownership even after timeout
        // and removal here. A concurrent waiter shares this entry's completion.
        if first_failure {
            Err("preview_stop_failed")
        } else {
            Ok(())
        }
    }
    pub fn close(&self, session: &str) {
        let Ok(mut closed) = self.closed.lock() else {
            return;
        };
        closed.insert(session.into());
        if let Ok(mut generations) = self.generations.lock() {
            let generation = generations.entry(session.into()).or_default();
            *generation = generation.wrapping_add(1);
        }
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values().filter(|e| e.session == session) {
                entry.process.cancellation().cancel();
            }
        }
    }
    pub fn reopen(&self, session: &str) {
        if let Ok(mut closed) = self.closed.lock() {
            closed.remove(session);
        }
    }
    pub async fn stop_closed(&self, session: &str) -> Result<(), &'static str> {
        self.stop_session(session, true).await
    }
    /// Event cleanup preserves a failed receipt briefly for the lifecycle caller.
    pub async fn cleanup_closed(&self, session: &str) {
        let _ = self.stop_session(session, false).await;
    }
    async fn stop_session(&self, session: &str, report: bool) -> Result<(), &'static str> {
        let entries: Vec<_> = {
            let _start = self.starts.lock().await;
            self.entries
                .lock()
                .map_err(|_| "preview_unavailable")?
                .iter()
                .filter(|(_, e)| e.session == session && e.process.cancellation().is_cancelled())
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect()
        }; // No global lock spans kill completion; unrelated previews remain usable.
        // Borrowing futures run together without detaching registry mutations.
        let results = futures_util::future::join_all(
            entries
                .iter()
                .map(|(id, entry)| self.stop_entry(id, entry, report)),
        )
        .await;
        results.into_iter().collect()
    }
    pub fn shutdown(&self) {
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values() {
                entry.process.cancellation().cancel();
            }
        }
    }
}
fn summary(id: &str, entry: &Preview) -> Value {
    json!({"status":"ok","preview_id":id,"port":entry.port,"pid":entry.process.pid(),"untrusted_log":entry.process.log()})
}
async fn ready(target: &Target) -> bool {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if target.cancel.is_cancelled() {
                return false;
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", target.port))
                .await
                .is_ok()
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or(false)
}
