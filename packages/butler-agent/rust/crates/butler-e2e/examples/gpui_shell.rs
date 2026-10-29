//! W3 manual harness: real isolated agent, stub provider, live gpui shots (not an E2E tier).
use anyhow::{Context as _, bail};
use butler_e2e::e2e::scenario::{Access, Setup};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::{Child, ChildStdin, Command},
};
#[path = "gpui_shell/stub.rs"]
mod stub;

struct Shots {
    child: Child,
    input: ChildStdin,
    output: BufReader<tokio::fs::File>,
}
impl Shots {
    async fn start(binary: &Path, data: &Path, dir: &Path, dark: bool) -> anyhow::Result<Self> {
        let stdout_path = dir.join("shots.stdout");
        let stdout = tokio::fs::File::create(&stdout_path)
            .await?
            .into_std()
            .await;
        let stderr = tokio::fs::File::create(dir.join("shots.stderr"))
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
        self.input.write_all(b"quit\n").await?;
        if !self.child.wait().await?.success() {
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
    for (dark, theme) in [(false, "light"), (true, "dark")] {
        let dir = output.join(theme);
        tokio::fs::create_dir_all(&dir).await?;
        run(Path::new(binary), &dir, dark).await?;
    }
    Ok(())
}
async fn run(binary: &Path, dir: &Path, dark: bool) -> anyhow::Result<()> {
    for decision in ["allow", "deny", "cancel"] {
        let out = dir.join(decision);
        tokio::fs::create_dir_all(&out).await?;
        let setup = Setup::new("GPUI-LIVE")?
            .data_folder_token()
            .access(Access::AskAlways)
            .env("BUTLER_APP_SERVER_PORT", "0")
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
        let result = scenario(binary, &out, dark, decision, &mut s).await;
        if result.is_err() {
            let feedback: Vec<_> = s
                .provider
                .as_ref()
                .into_iter()
                .flat_map(|p| p.requests())
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
        }
        let cleanup = s.finish().await.map_err(|e| anyhow::anyhow!(e.to_string()));
        result?;
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
) -> anyhow::Result<()> {
    let mut h = Shots::start(binary, &s.sandbox.data, dir, dark).await?;
    for command in [
        "connected",
        "shot listed",
        "open general",
        "shot open",
        "new",
    ] {
        h.command(command).await?;
    }
    h.command(&format!("send {}", stub::PROMPT)).await?;
    h.command("approval").await?;
    h.command(&format!("exact {}", stub::ACTION)).await?;
    h.command("shot approval").await?;
    h.command("modify").await?;
    h.command("shot modify").await?;
    h.command("close").await?;
    h.command(decision).await?;
    if decision == "allow" {
        h.command("streaming shell answer").await?;
        h.command("shot streaming").await?;
        h.command("answer shell answer").await?;
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
    h.command("connected").await?;
    h.command("shot reattached").await?;
    h.finish().await
}
