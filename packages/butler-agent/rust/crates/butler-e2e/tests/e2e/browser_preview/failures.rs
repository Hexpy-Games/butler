//! Public lifecycle regression: one failure cannot poison future session cleanup.
use super::*;
use std::time::{Duration, Instant};

fn setup(name: &str) -> Result<Setup, HarnessError> {
    let setup = if std::env::var_os("BUTLER_E2E_FAULT_BIN").is_some() {
        Setup::mutates_installation(name)?
    } else {
        Setup::new(name)?
    }
    .env(
        "PATH",
        std::env::var("PATH").expect("runner PATH is required"),
    );
    // The injected stop and pidfd failures exist only in a test-support Agent.
    // The perf tier runs the production Agent, so these use the test-support
    // Agent CI supplies there, as the steward and sandbox fixtures do.
    if let Some(binary) = std::env::var_os("BUTLER_E2E_FAULT_BIN") {
        butler_e2e::e2e::executable::copy(std::path::Path::new(&binary), &setup.sandbox.binary)?;
    }
    std::fs::write(
        setup.sandbox.workspace.join("server.mjs"),
        "Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[2]),fetch(){return new Response('ready')}});",
    )?;
    Ok(setup)
}
fn args(cwd: &std::path::Path, id: &str) -> Value {
    let port = port();
    json!({"agent":"preview-agent","preview_id":id,"command":format!("bun server.mjs {port}"),"cwd":cwd,"port":port})
}
async fn session(s: &butler_e2e::e2e::scenario::Scenario) -> Result<String, HarnessError> {
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Stop failure"}))
            .await?;
    Ok(created.data()["session"]["id"].as_str().unwrap().into())
}

#[tokio::test]
async fn failed_stop_is_reported_once_and_later_archive_delete_succeed() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for mode in ["error", "timeout"] {
        let setup = setup("BROWSER-PREVIEW-FAILURE")?.env("BUTLER_TEST_PREVIEW_COMPLETION", mode);
        let cwd = setup.sandbox.workspace.clone();
        let s = setup.start().await?;
        let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
        let id = session(&s).await?;
        let start = args(&cwd, "lifecycle-failure");
        assert_eq!(
            call(&admin, &id, "preview.start", start.clone()).await?["status"],
            "ok"
        );
        let archive_path = format!("/sessions/{id}/archive");
        let began = Instant::now();
        let (archived, unrelated) = tokio::join!(s.gw.post(&archive_path, json!({})), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let other = session(&s).await?;
            let result = call(&admin, &other, "preview.start", args(&cwd, "unrelated")).await?;
            assert_eq!(result["status"], "ok");
            if mode == "timeout" {
                butler_e2e::assert_wall_clock_budget!(
                    began.elapsed(),
                    butler_platform::preview_process::STOP_WAIT_LIMIT,
                    "another session must start before the pending stop finishes"
                );
            }
            Ok::<_, HarnessError>(other)
        });
        let elapsed = began.elapsed();
        let archived = archived?;
        assert_eq!(archived.status, 500, "{mode}: {}", archived.body);
        assert!(archived.body.to_string().contains("preview_stop_failed"));
        butler_e2e::assert_wall_clock_budget!(
            elapsed,
            Duration::from_secs(5),
            "kill wait must be bounded"
        );
        let port = u16::try_from(start["port"].as_u64().unwrap()).unwrap();
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
        );
        assert_eq!(
            s.gw.post(&format!("/sessions/{id}/archive"), json!({}))
                .await?
                .status,
            200
        );
        assert_eq!(
            s.gw.delete(&format!("/sessions/{id}?permanent=true"))
                .await?
                .status,
            200
        );
        // Explicit stop consumes the same receipt; archive cannot report it again.
        let other = unrelated?;
        assert_eq!(
            call(
                &admin,
                &other,
                "preview.stop",
                json!({"agent":"preview-agent","preview_id":"unrelated"})
            )
            .await?["reason"],
            "preview_stop_failed"
        );
        assert_eq!(
            s.gw.post(&format!("/sessions/{other}/archive"), json!({}))
                .await?
                .status,
            200
        );
        assert_eq!(
            s.gw.delete(&format!("/sessions/{other}?permanent=true"))
                .await?
                .status,
            200
        );
        println!(
            "{mode}: failed stop reported once; unrelated start unblocked; archive elapsed {elapsed:?}"
        );
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn unavailable_pidfds_fall_back_to_launcher_reaping() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::preview_process::has_group_exit_notifications(),
        "pidfds require Linux"
    );
    for errno in ["ENOSYS", "EPERM"] {
        let setup = setup("BROWSER-PREVIEW-PIDFD")?.env("BUTLER_TEST_PREVIEW_PIDFD", errno);
        let cwd = setup.sandbox.workspace.clone();
        let s = setup.start().await?;
        let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
        let id = session(&s).await?;
        assert_eq!(
            call(&admin, &id, "preview.start", args(&cwd, "fallback")).await?["status"],
            "ok"
        );
        assert_eq!(
            call(
                &admin,
                &id,
                "preview.stop",
                json!({"agent":"preview-agent","preview_id":"fallback"})
            )
            .await?["status"],
            "ok",
            "{errno}"
        );
        assert_eq!(
            s.gw.post(&format!("/sessions/{id}/archive"), json!({}))
                .await?
                .status,
            200
        );
        println!("{errno}: launcher reaped without rejecting stop");
        s.finish().await?;
    }
    Ok(())
}
