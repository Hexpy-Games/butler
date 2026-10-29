//! W3 manual harness: real isolated agent, stub provider, live gpui shots (not an E2E tier).
use anyhow::{Context as _, bail};
use butler_e2e::e2e::scenario::{Access, Setup};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::{Child, ChildStdin, Command},
};
#[path = "gpui_shell/activity.rs"]
mod activity;
#[path = "gpui_shell/proxy.rs"]
mod proxy;
#[path = "gpui_shell/replay.rs"]
mod replay;
#[path = "gpui_shell/stub.rs"]
mod stub;

struct Shots {
    child: Child,
    input: ChildStdin,
    output: BufReader<tokio::fs::File>,
}
impl Shots {
    async fn start(binary: &Path, data: &Path, dir: &Path, dark: bool) -> anyhow::Result<Self> {
        let logs = std::env::temp_dir().join(format!("gpui-shots-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&logs).await?;
        let stdout_path = logs.join("shots.stdout");
        let stdout = tokio::fs::File::create(&stdout_path)
            .await?
            .into_std()
            .await;
        let stderr = tokio::fs::File::create(logs.join("shots.stderr"))
            .await?
            .into_std()
            .await;
        let mut cmd = Command::new(binary);
        cmd.arg(dir)
            .arg("--data")
            .arg(data)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .kill_on_drop(true);
        if dark {
            cmd.arg("--dark");
        }
        let mut child = cmd.spawn()?;
        let input = child.stdin.take().context("stdin")?;
        let output = BufReader::new(tokio::fs::File::open(stdout_path).await?);
        let mut shots = Self {
            child,
            input,
            output,
        };
        shots.ack("LIVE READY").await?;
        Ok(shots)
    }
    async fn ack(&mut self, expected: &str) -> anyhow::Result<()> {
        tokio::time::timeout(std::time::Duration::from_secs(90), async {
            let mut line = String::new();
            loop {
                if self.output.read_line(&mut line).await? == 0 {
                    if self.child.try_wait()?.is_some() {
                        bail!("shots exited before {expected}");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    continue;
                }
                if !line.ends_with('\n') {
                    continue;
                }
                if line.trim() == expected {
                    return Ok(());
                }
                print!("{line}");
                line.clear();
            }
        })
        .await?
    }
    async fn command(&mut self, command: &str) -> anyhow::Result<()> {
        self.input
            .write_all(format!("{command}\n").as_bytes())
            .await?;
        self.ack("LIVE OK").await
    }
    async fn finish(mut self) -> anyhow::Result<()> {
        let sent = self.input.write_all(b"quit\n").await;
        let waited =
            tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait()).await;
        let status = match waited {
            Ok(status) => status?,
            Err(_) => {
                self.child.kill().await?;
                self.child.wait().await?
            }
        };
        sent?;
        if !status.success() {
            bail!("shots failed");
        }
        Ok(())
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    let binary = args
        .get(1)
        .context("usage: gpui_shell <shots binary> <output>")?;
    let output = std::path::PathBuf::from(args.get(2).context("output")?);
    if args.get(3).is_some_and(|arg| arg == "--replay-only") {
        return replay::run(Path::new(binary), &output.join("replay")).await;
    }
    for (dark, theme) in [(false, "light"), (true, "dark")] {
        let dir = output.join(theme);
        tokio::fs::create_dir_all(&dir).await?;
        run(Path::new(binary), &dir, dark).await?;
    }
    replay::run(Path::new(binary), &output.join("replay")).await?;
    Ok(())
}
async fn run(binary: &Path, dir: &Path, dark: bool) -> anyhow::Result<()> {
    for decision in ["allow", "deny", "cancel"] {
        let out = dir.join(decision);
        tokio::fs::create_dir_all(&out).await?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let clock = listener.local_addr()?.to_string();
        drop(listener);
        let setup = Setup::new("GPUI-LIVE")?
            .data_folder_token()
            .access(Access::AskAlways)
            .env("BUTLER_APP_SERVER_PORT", "0")
            .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &clock)
            .stub_cassette(stub::cassette()?);
        let mut s = setup
            .start()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        // Keep the stub's streaming boundary visible to the screenshot consumer.
        if let Some(provider) = &s.provider {
            provider.set_pacing(butler_e2e::e2e::provider::Pacing {
                scale: 1.,
                cap_ms: stub::STREAM_CHUNK_DELAY,
                min_ms: 0,
            });
        }
        s.agent
            .launch
            .set_env("BUTLER_APP_SERVER_PORT", s.agent.launch.port.to_string());
        let result = scenario(binary, &out, dark, decision, &mut s, &clock).await;
        let diagnostics = if result.is_err() {
            diagnostics(&s, &out).await
        } else {
            Ok(())
        };
        let stopped = s
            .agent
            .terminate()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()));
        let cleanup = s.finish().await.map_err(|e| anyhow::anyhow!(e.to_string()));
        result?;
        diagnostics?;
        stopped?;
        cleanup?;
    }
    Ok(())
}
async fn scenario(
    binary: &Path,
    dir: &Path,
    dark: bool,
    decision: &str,
    s: &mut butler_e2e::e2e::scenario::Scenario,
    clock: &str,
) -> anyhow::Result<()> {
    seed_roles(s).await?;
    let proxy = proxy::Proxy::start(s.gw.base.clone()).await?;
    proxy.attach(&s.sandbox.data).await?;
    let mut h = Shots::start(binary, &s.sandbox.data, dir, dark).await?;
    let result = async {
        for command in [
            "connected",
            "shot listed",
            "open general",
            "roles",
            "shot open",
        ] {
            h.command(command).await?;
        }
        let (older, newer) = activity::prepare(s, &mut h, clock).await?;
        h.command(&format!("send {}", stub::PROMPT)).await?;
        h.command("approval").await?;
        h.command(&format!("before {older} {newer}")).await?;
        h.command("shot activity-reordered").await?;
        h.command(&format!("exact {}", stub::ACTION)).await?;
        h.command("shot approval").await?;
        h.command("modify").await?;
        h.command("shot modify").await?;
        h.command("close").await?;
        h.command(decision).await?;
        if decision == "allow" {
            h.command("streaming shell answer").await?;
            h.command("shot streaming").await?;
            let began = std::time::Instant::now();
            proxy.burst()?;
            h.command("stable").await?;
            h.command("answer shell answer").await?;
            if proxy.refused() < 3 { bail!("503 burst did not exceed the request retry budget"); }
            h.command("attached").await?;
            h.command("shot resumed-after-503").await?;
            tokio::fs::write(dir.join("503.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "refused":proxy.refused(), "elapsed_ms":began.elapsed().as_millis(), "later_answer":"shell answer"
            }))?).await?;
        }
        h.command(&format!("shot {decision}")).await?;
        s.agent
            .terminate()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        h.command("disconnected").await?;
        h.command("shot disconnected").await?;
        s.restart()
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        proxy.attach(&s.sandbox.data).await?;
        h.command("connected").await?;
        h.command("shot reattached").await?;
        verify_outcome(s, dir, decision).await?;
        let page =
            s.gw.get("/sessions?limit=20")
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let chat = page.data()["items"]
            .as_array()
            .context("sessions")?
            .iter()
            .filter_map(|row| row["id"].as_str())
            .find(|id| *id != "general")
            .context("created chat")?;
        h.command(&format!("open {chat}")).await?;
        h.command("shot before-delete").await?;
        let deleted =
            s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if deleted.status != 200 {
            bail!("gateway delete failed: {}", deleted.status);
        }
        h.command(&format!("left {chat}")).await?;
        h.command("shot deleted-open-chat").await
    }
    .await;
    let cleanup = h.finish().await;
    result?;
    cleanup
}

/// Independent gateway evidence after restart, alongside the rendered UI evidence.
async fn verify_outcome(
    s: &butler_e2e::e2e::scenario::Scenario,
    dir: &Path,
    decision: &str,
) -> anyhow::Result<()> {
    let page =
        s.gw.get("/sessions?limit=20")
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let mut turns = Vec::new();
    for row in page.data()["items"].as_array().into_iter().flatten() {
        let id = row["id"].as_str().context("session id")?;
        let view =
            s.gw.get(&format!("/session-view?session_id={id}"))
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if !view.data()["latest_turn"].is_null() {
            turns.push(view.data()["latest_turn"].clone());
        }
    }
    let expected = if decision == "cancel" {
        "cancelled"
    } else {
        "delivered"
    };
    if turns.len() != 1 || turns[0]["state"] != expected {
        bail!("unexpected persisted turn outcome");
    }
    let feedback: Vec<serde_json::Value> = s
        .provider
        .as_ref()
        .into_iter()
        .flat_map(butler_e2e::e2e::provider::Provider::requests)
        .flat_map(|request| request["input"].as_array().cloned().unwrap_or_default())
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| serde_json::from_str(item["output"].as_str().unwrap_or_default()))
        .collect::<Result<_, _>>()?;
    let executed = feedback
        .iter()
        .any(|value| value["output"]["command_outcome_observed"] == true);
    let refused = feedback.iter().any(|value| value["ok"] == false);
    if decision == "allow" && !executed {
        bail!("allowed command was not executed");
    }
    if decision == "deny" && (executed || !refused) {
        bail!("denied command was not refused");
    }
    let evidence = serde_json::json!({"turns":turns,"command_executed":executed,"tool_refused":refused,"feedback":feedback});
    tokio::fs::write(
        dir.join("verified.json"),
        serde_json::to_vec_pretty(&evidence)?,
    )
    .await?;
    Ok(())
}

async fn diagnostics(s: &butler_e2e::e2e::scenario::Scenario, out: &Path) -> anyhow::Result<()> {
    let feedback: Vec<_> = s
        .provider
        .as_ref()
        .into_iter()
        .flat_map(butler_e2e::e2e::provider::Provider::requests)
        .flat_map(|request| request["input"].as_array().cloned().unwrap_or_default())
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| item["output"].clone())
        .collect();
    tokio::fs::write(
        out.join("feedback.json"),
        serde_json::to_vec_pretty(&feedback)?,
    )
    .await?;
    let sessions =
        s.gw.get("/sessions?limit=20")
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let mut views = Vec::new();
    for row in sessions.data()["items"].as_array().into_iter().flatten() {
        if let Some(id) = row["id"].as_str() {
            let view =
                s.gw.get(&format!("/session-view?session_id={id}"))
                    .await
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let data = view.data();
            views.push(serde_json::json!({"session":id,"messages":data["messages"],"latest_turn":data["latest_turn"],"authority_requests":data["authority_requests"]}));
        }
    }
    tokio::fs::write(out.join("failure.json"), serde_json::to_vec_pretty(&views)?).await?;
    Ok(())
}

async fn seed_roles(s: &mut butler_e2e::e2e::scenario::Scenario) -> anyhow::Result<()> {
    s.agent
        .terminate()
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let path = s.sandbox.data.join(butler_platform::data_paths::APP_DB);
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = butler_platform::sqlite::open(path)?;
        for role in ["automation", "system"] {
            db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES(?1,'general',?1,?2,'delivered','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z')",
                [role, &format!("{role}: Scheduled result")])?;
        }
        Ok(())
    }).await??;
    s.restart()
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    Ok(())
}
