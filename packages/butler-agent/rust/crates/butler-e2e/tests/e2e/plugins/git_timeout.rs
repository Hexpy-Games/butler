use super::{git_support::empty, *};
use std::time::{Duration, Instant};
use tokio::{io::AsyncReadExt, net::TcpListener};

#[tokio::test]
async fn hanging_git_times_out_without_blocking_configuration_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("plugin-git-timeout")?.env("BUTLER_PLUGIN_GIT_TIMEOUT_SECS", "6");
    let trace = setup.sandbox.home.join("git-events.jsonl");
    let setup = setup.env("GIT_TRACE2_EVENT", trace.to_string_lossy());
    let path = package(&setup.sandbox.home, "helper")?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let remote = format!("git://{}/package", listener.local_addr()?);
    let s = setup.start().await?;
    install(&s, &path).await?;
    let rev = revision(&s).await?;
    let inspect = api(
        &s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"git":remote})),
    );
    let exercise = async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        let start = Instant::now();
        let (disable, settings) = tokio::join!(
            tokio::time::timeout(
                Duration::from_secs(2),
                api(
                    &s,
                    Method::POST,
                    "/plugins/helper/disable",
                    Some(json!({"revision":rev}))
                )
            ),
            tokio::time::timeout(
                Duration::from_secs(2),
                api(
                    &s,
                    Method::PATCH,
                    "/settings",
                    Some(json!({"language":"ko"}))
                )
            )
        );
        let elapsed = start.elapsed();
        // Always release the transport, including on the unfixed host, before asserting.
        let eof = tokio::time::timeout(Duration::from_secs(8), socket.read(&mut request)).await;
        (disable, settings, elapsed, eof)
    };
    let (inspection, (disable, settings, elapsed, eof)) = tokio::join!(inspect, exercise);
    let inspection = inspection?;
    assert!(disable.is_ok(), "plugin disable blocked for {elapsed:?}");
    assert!(settings.is_ok(), "settings write blocked for {elapsed:?}");
    assert_eq!(disable.unwrap()?.status, 200);
    assert_eq!(settings.unwrap()?.status, 200);
    assert_eq!(inspection.status, 400, "{inspection:?}");
    assert!(
        inspection.text.contains("plugin_git_timeout"),
        "{inspection:?}"
    );
    assert!(
        matches!(eof, Ok(Ok(0))),
        "git transport still alive: {eof:?}"
    );
    assert!(empty(&s.sandbox.data.join("plugins/staging")));
    assert!(empty(&s.sandbox.data.join("plugins/work")));
    let events = fs::read_to_string(trace)?;
    for line in events.lines() {
        let event: Value = serde_json::from_str(line)?;
        if event["event"] == "start" {
            let sid = event["sid"].as_str().unwrap();
            let pid = u32::from_str_radix(sid.rsplit_once("-P").unwrap().1, 16).unwrap();
            assert_eq!(
                butler_platform::process_control::liveness(pid),
                butler_platform::process_control::Liveness::Gone,
                "git child {pid} survived"
            );
        }
    }
    eprintln!("configuration writes completed in {elapsed:?}; git transport closed");
    s.finish().await
}
