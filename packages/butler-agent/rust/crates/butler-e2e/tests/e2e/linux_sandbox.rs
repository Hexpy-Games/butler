//! Linux P1/P4: real command boundary and public-chat approval admission.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod boundaries;
mod latency;
mod mount_aliases;
mod npm_tarball;
mod project_boundaries;
mod project_write;
mod reader_perf;
mod reader_refusals;
mod secret_changes;
mod secret_inventory;
mod secret_links;
mod secret_perf;
mod tiers;
mod tools;
mod windows_drive;
use super::access_tiers::stub;

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id},
};
use butler_platform::command_sandbox::{self, Invocation};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// `BUTLER_TEST_LANDLOCK_ABI` exists only in a `test-support` Agent. The perf
/// tier runs the production Agent on a real kernel, so a test that caps the
/// ABI uses the test-support Agent CI supplies there (as the steward
/// presentation fixtures do for the debug hooks); the stub tier already runs it.
fn test_support_agent(setup: Setup) -> Result<Setup, HarnessError> {
    if let Some(binary) = std::env::var_os("BUTLER_E2E_FAULT_BIN") {
        butler_e2e::e2e::executable::copy(Path::new(&binary), &setup.sandbox.binary)?;
    }
    Ok(setup)
}

struct SocketPath(PathBuf);
impl Drop for SocketPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn run(invocation: Invocation, cwd: &Path, home: &Path) -> std::process::Output {
    Command::new(invocation.program)
        .args(invocation.arguments)
        .current_dir(cwd)
        .env("HOME", home)
        .output()
        .unwrap()
}

#[tokio::test]
async fn kernel_boundaries_secrets_network_and_unicode() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    let caps = command_sandbox::capabilities();
    eprintln!("Linux sandbox capabilities: {caps:?}");
    assert!(
        caps.approval_free_reads(),
        "Linux stub runner must enforce P1/P4"
    );
    let mut setup = Setup::new("LINUX-SANDBOX")?;
    let home = &setup.sandbox.home;
    let cwd = home.join("프로젝트 ✓/깊은 경로");
    std::fs::create_dir_all(&cwd)?;
    std::fs::create_dir_all(home.join(".ssh"))?;
    std::fs::write(home.join(".ssh/id_test"), "fixture-private-key")?;
    std::fs::write(setup.sandbox.data.join("token"), "fixture-butler-token")?;
    std::fs::write(cwd.join("visible.txt"), "visible-content")?;
    std::fs::write(cwd.join(".ENV.local"), "fixture-project-secret")?;
    butler_platform::secure_fs::symlink(&home.join(".ssh/id_test"), &cwd.join("credential-alias"))?;
    butler_platform::secure_fs::symlink(&cwd.join("visible.txt"), &cwd.join("public-alias"))?;
    let environment = HashMap::from([("HOME".into(), home.display().to_string())]);
    let invoke = |command: &str| {
        command_sandbox::login_shell_contained(command, &environment, &[], &[&cwd]).unwrap()
    };
    let output = run(invoke("ls -1; cat visible.txt; pwd"), &cwd, home);
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("visible.txt") && text.contains("visible-content"));
    assert!(text.contains("프로젝트 ✓/깊은 경로"));
    let alias = run(invoke("cat public-alias"), &cwd, home);
    assert!(alias.status.success(), "{alias:?}");
    assert_eq!(alias.stdout, b"visible-content");
    let output = run(invoke("echo x > denied.txt"), &cwd, home);
    assert!(!output.status.success());
    assert!(!cwd.join("denied.txt").exists());
    assert_eq!(
        command_sandbox::sandbox_denial(&String::from_utf8(output.stderr).unwrap())
            .unwrap()
            .0,
        "possible"
    );
    for path in [
        home.join(".ssh/id_test"),
        cwd.join(".ENV.local"),
        cwd.join("credential-alias"),
    ] {
        let output = run(invoke(&format!("cat '{}'", path.display())), &cwd, home);
        assert!(!output.status.success(), "{output:?}");
        assert!(output.stdout.is_empty(), "secret contents escaped");
    }
    let output = run(
        invoke(&format!(
            "cat '{}'",
            setup.sandbox.data.join("token").display()
        )),
        &cwd,
        home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"fixture-butler-token");
    let tcp = std::net::TcpListener::bind("127.0.0.1:0")?;
    tcp.set_nonblocking(true)?;
    // sockaddr_un's fixed length needs a short fixture path even when TMPDIR
    // names a long worktree. The guard removes it on every exit path.
    let unix_path = SocketPath(PathBuf::from(format!(
        "/tmp/bt-{}.sock",
        uuid::Uuid::new_v4()
    )));
    let unix = command_sandbox::UnixSocketProbe::bind(&unix_path.0)?;
    let udp = std::net::UdpSocket::bind("127.0.0.1:0")?;
    udp.set_nonblocking(true)?;
    for script in [
        "import socket; socket.socket(socket.AF_INET6)".into(),
        "import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW)".into(),
        format!(
            "import socket; socket.create_connection(('127.0.0.1', {}))",
            tcp.local_addr()?.port()
        ),
        format!(
            "import socket; s=socket.socket(socket.AF_UNIX); s.connect('{}')",
            unix_path.0.display()
        ),
        format!(
            "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b'x', ('127.0.0.1', {}))",
            udp.local_addr()?.port()
        ),
    ] {
        let command = format!("python3 -c \"{script}\"");
        let output = run(invoke(&command), &cwd, home);
        assert!(!output.status.success(), "{output:?}");
        assert_eq!(
            command_sandbox::sandbox_denial(&String::from_utf8(output.stderr).unwrap())
                .unwrap()
                .0,
            "possible"
        );
    }
    assert_eq!(
        tcp.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        unix.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        udp.recv(&mut [0; 1]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    // Anonymous local stream IPC remains available under P4.
    let output = run(
        invoke(
            "python3 -c 'import socket; a,b=socket.socketpair(); a.send(b\"ok\"); assert b.recv(2)==b\"ok\"'",
        ),
        &cwd,
        home,
    );
    assert!(output.status.success(), "{output:?}");
    setup.sandbox.mark_success();
    Ok(())
}

async fn admission(abi_cap: Option<u32>) -> Result<(), HarnessError> {
    let capped = abi_cap.is_some();
    let (url, script, server) = stub::start().await?;
    let mut setup = if capped && std::env::var_os("BUTLER_E2E_FAULT_BIN").is_some() {
        Setup::mutates_installation("LINUX-ADMISSION")?
    } else {
        Setup::new("LINUX-ADMISSION")?
    };
    if capped {
        setup = test_support_agent(setup)?;
    }
    let mut setup = setup
        .access(Access::AskExceptReads)
        .data_folder_token()
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    if let Some(cap) = abi_cap {
        setup = setup.env("BUTLER_TEST_LANDLOCK_ABI", cap.to_string());
    }
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::write(project.join("visible.txt"), "fixture-listing")?;
    let tcp = std::net::TcpListener::bind("127.0.0.1:0")?;
    tcp.set_nonblocking(true)?;
    let unreadable = project.join("dac-unreadable.txt");
    std::fs::write(&unreadable, "fixture-dac-private")?;
    butler_platform::secure_fs::set_file_mode(
        &unreadable,
        butler_platform::secure_fs::FileMode::from_bits(0),
    )
    .unwrap()?;
    let dac_read = "cat dac-unreadable.txt";
    let baseline = run(
        command_sandbox::login_shell(
            dac_read,
            command_sandbox::ShellAccess::Full,
            &HashMap::new(),
        )
        .unwrap(),
        &project,
        &s.sandbox.home,
    );
    assert!(
        !baseline.status.success(),
        "fixture must yield plain DAC EACCES"
    );
    assert!(String::from_utf8_lossy(&baseline.stderr).contains("Permission denied"));
    let network = format!(
        "python3 -c \"import socket; socket.create_connection(('127.0.0.1', {}))\"",
        tcp.local_addr()?.port()
    );
    for (prompt, command) in [
        ("List the project.", "ls -1"),
        ("Read a file with restrictive permissions.", dac_read),
        ("Observe a write attempt.", "echo x > denied.txt"),
        ("Observe a connection attempt.", network.as_str()),
    ] {
        if capped && command != "ls -1" {
            continue;
        }
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![stub::call(
                "command",
                "run_command",
                &json!({
                    "command":command,"summary":"Inspect files","state_effect":"read_only"
                }),
            )],
        );
        let id = accepted_turn_id(&s.gw.say(&chat, prompt).await?)?;
        if capped {
            let turn =
                s.gw.wait_turn(
                    &chat,
                    &id,
                    &["waiting_for_form", "delivered", "failed"],
                    Duration::from_secs(20),
                )
                .await?;
            assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
            let cards = s.gw.approval_requests(&chat).await?;
            assert_eq!(cards.len(), 1);
            assert_eq!(
                cards[0]["approval"]["command_access"],
                "read_only_unisolated"
            );
            let reference = cards[0]["request_ref"].as_str().unwrap();
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id={chat}"),
                json!({"scope":"once"}),
            )
            .await?;
        }
        let turn =
            s.gw.wait_terminal(&chat, &id, Duration::from_secs(20))
                .await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
        let requests = script.requests_for(prompt);
        let output = requests
            .iter()
            .flat_map(|request| request["input"].as_array().unwrap())
            .find_map(|item| {
                (item["type"] == "function_call_output")
                    .then(|| item["output"].as_str())
                    .flatten()
            })
            .expect("model sees command result");
        let value: Value = serde_json::from_str(output)?;
        let body = value
            .get("output")
            .filter(|v| v.is_object())
            .unwrap_or(&value);
        assert_eq!(
            body["sandbox"],
            if capped {
                "unisolated"
            } else {
                "read_only_no_network"
            },
            "{body}"
        );
        if command == "ls -1" {
            assert_eq!(body["ok"], true, "{body}");
            assert!(body["stdout"].as_str().unwrap().contains("visible.txt"));
        } else if command == dac_read {
            assert_eq!(body["ok"], false, "{body}");
            assert!(body.get("sandbox_denied").is_none(), "{body}");
            assert_eq!(body["sandbox_denial"], "possible", "{body}");
            let hint = body["next_step"].as_str().unwrap();
            assert!(hint.contains("may have been denied by the sandbox"));
            assert!(hint.contains("ordinary filesystem permissions"));
            assert!(!hint.contains("was denied write access"));
        } else if command == "echo x > denied.txt" {
            assert_eq!(body["ok"], false, "{body}");
            assert_eq!(body["sandbox_denial"], "possible", "{body}");
            assert!(
                body["next_step"]
                    .as_str()
                    .unwrap()
                    .contains("state_effect \"mutation\"")
            );
            assert!(!project.join("denied.txt").exists());
        } else {
            assert_eq!(body["ok"], false, "{body}");
            assert_eq!(body["sandbox_denial"], "possible", "{body}");
            assert!(
                body["next_step"]
                    .as_str()
                    .unwrap()
                    .contains("remote_observation")
            );
            assert_eq!(
                tcp.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let count: u64 = db.query_row(
            "SELECT count(*) FROM btcc_authority_requests WHERE source_turn_id=?1",
            [&id],
            |r| r.get(0),
        )?;
        assert_eq!(count, u64::from(capped));
    }
    if !capped {
        let token = s
            .sandbox
            .data
            .join(butler_e2e::e2e::agent::DATA_FOLDER_TOKEN_FILE);
        assert!(token.is_file(), "agent owns the token in its data folder");
        let environment = HashMap::from([("HOME".into(), s.sandbox.home.display().to_string())]);
        let invocation = command_sandbox::login_shell_contained(
            &format!("cat '{}'", token.display()),
            &environment,
            &[],
            &[&project],
        )
        .unwrap();
        let result = run(invocation, &project, &s.sandbox.home);
        assert!(result.status.success(), "data-folder read must succeed");
        assert!(
            result.stdout == std::fs::read(&token)?,
            "data-folder read must return the complete file"
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn list_and_write_attempt_need_no_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    admission(None).await
}

#[tokio::test]
async fn capped_abi_keeps_exact_approval_fallback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    for cap in [2, 3, 4, 5] {
        admission(Some(cap)).await?;
    }
    Ok(())
}
