//! Ephemeral preview registry: command identity, agent budget, ports and tree lifetime.
use butler_platform::preview_process::PreviewProcess;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Previews {
    entries: Mutex<HashMap<String, Preview>>,
    closed: Mutex<HashSet<String>>,
    starts: tokio::sync::Mutex<()>,
    stops: tokio::sync::Mutex<()>,
}
struct Preview {
    session: String,
    agent: String,
    command: String,
    cwd: PathBuf,
    port: u16,
    process: PreviewProcess,
    created_at: String,
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
}
impl Previews {
    pub async fn start(
        &self,
        session: &str,
        agent: &str,
        id: &str,
        args: &Value,
    ) -> Result<Value, &'static str> {
        let _start = self.starts.lock().await;
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
                .filter(|p| (1024..=65535).contains(p) && ![18765, 19765].contains(p))
                .and_then(|p| u16::try_from(p).ok())
                .ok_or("invalid_port")?,
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
        if !ready(&process, input.port).await {
            process.stop().await;
            return Err("preview_not_ready");
        }
        self.register(input, process)
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
    fn register(&self, input: Start<'_>, process: PreviewProcess) -> Result<Value, &'static str> {
        let closed = self.closed.lock().map_err(|_| "preview_unavailable")?;
        if closed.contains(input.session) {
            return Err("session_closed");
        }
        let entry = Preview {
            session: input.session.into(),
            agent: input.agent.into(),
            command: input.command.into(),
            cwd: input.cwd,
            port: input.port,
            process,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let result = summary(input.id, &entry);
        self.entries
            .lock()
            .map_err(|_| "preview_unavailable")?
            .insert(input.id.into(), entry);
        Ok(result)
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
        let entry = {
            let mut entries = self.entries.lock().map_err(|_| "preview_unavailable")?;
            if entries
                .get(id)
                .is_none_or(|e| e.session != session || e.agent != agent)
            {
                return Err("not_your_preview");
            }
            entries.remove(id).ok_or("not_your_preview")?
        };
        let log = entry.process.log();
        entry.process.stop().await;
        Ok(json!({"status":"ok","preview_id":id,"untrusted_log":log}))
    }
    pub fn close(&self, session: &str) {
        if let Ok(mut closed) = self.closed.lock() {
            closed.insert(session.into());
        }
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values().filter(|e| e.session == session) {
                entry.process.cancellation().cancel();
            }
        }
    }
    pub async fn stop_closed(&self, session: &str) {
        let _stop = self.stops.lock().await;
        self.close(session);
        let removed: Vec<_> = self
            .entries
            .lock()
            .map(|mut entries| {
                let ids: Vec<_> = entries
                    .iter()
                    .filter(|(_, e)| e.session == session)
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| entries.remove(&id))
                    .collect()
            })
            .unwrap_or_default();
        for entry in removed {
            entry.process.stop().await;
        }
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
async fn ready(process: &PreviewProcess, port: u16) -> bool {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if !process.is_running() {
                return false;
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
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
