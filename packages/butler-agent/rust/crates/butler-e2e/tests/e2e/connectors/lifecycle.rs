use super::*;
#[tokio::test]
async fn pc1_accounts_own_one_child_and_stop_on_disconnect_disable_uninstall()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC1")?;
    let root = package(&setup.sandbox.home, false)?;
    let mut s = setup.start().await?;
    install(&s, &root).await?;
    let first = connect(&s, "immediate", 10.0).await?;
    account(&s, &first, "connected").await?;
    let pid = control_pid(&s, &first)?;
    assert_eq!(
        fs::read_to_string(data(&s).join(format!("{first}-starts")))?
            .lines()
            .count(),
        1
    );
    let second = connect(&s, "batch", 10.0).await?;
    account(&s, &second, "connected").await?;
    assert_ne!(pid, control_pid(&s, &second)?);
    let r = api(
        &s,
        Method::DELETE,
        &format!(
            "/connectors/source/items/accounts/{first}?revision={}",
            revision(&s).await?
        ),
        None,
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert_dead(pid);
    let pid = control_pid(&s, &second)?;
    let r = api(
        &s,
        Method::POST,
        "/plugins/source/disable",
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200);
    assert_dead(pid);
    let r = api(
        &s,
        Method::POST,
        "/plugins/source/enable",
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200);
    account(&s, &second, "connected").await?;
    s.restart().await?;
    account(&s, &second, "connected").await?;
    let pid = control_pid(&s, &second)?;
    let r = api(
        &s,
        Method::DELETE,
        &format!("/plugins/source?revision={}", revision(&s).await?),
        None,
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert_dead(pid);
    s.finish().await
}
fn control_pid(s: &Scenario, id: &str) -> Result<u32, HarnessError> {
    let v: Value = serde_json::from_slice(&fs::read(data(s).join(format!("{id}-control.json")))?)?;
    Ok(u32::try_from(v["pid"].as_u64().unwrap()).unwrap())
}
fn assert_dead(pid: u32) {
    assert_eq!(
        butler_platform::process_control::liveness(pid),
        butler_platform::process_control::Liveness::Gone
    );
}
#[tokio::test]
async fn pc4_crash_limit_keeps_gateway_responsive_and_retry_resets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC4")?;
    let root = package(&setup.sandbox.home, true)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    let mut longest = Duration::ZERO;
    for _ in 0..5 {
        let start = Instant::now();
        assert_eq!(api(&s, Method::GET, "/connectors", None).await?.status, 200);
        longest = longest.max(start.elapsed());
    }
    butler_e2e::assert_wall_clock_budget!(
        longest,
        Duration::from_secs(1),
        "gateway during connector crash loop"
    );
    account(&s, &id, "crashed").await?;
    assert_eq!(
        fs::read_to_string(data(&s).join(format!("{id}-starts")))?
            .lines()
            .count(),
        3
    );
    let r = api(
        &s,
        Method::POST,
        &format!("/connectors/source/items/accounts/{id}/retry"),
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200);
    account(&s, &id, "crashed").await?;
    assert_eq!(
        fs::read_to_string(data(&s).join(format!("{id}-starts")))?
            .lines()
            .count(),
        6
    );
    eprintln!(
        "PC4 gateway max response={} ms; crashes=3, retry crashes=3",
        longest.as_millis()
    );
    s.finish().await
}
#[tokio::test]
async fn pc3_connected_idle_is_notification_driven_and_writes_nothing() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("PC3")?;
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let reads = data(&s).join(format!("{id}-reads"));
    while !reads.exists() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = fs::read_to_string(&reads)?;
    assert_eq!(before, "1");
    let mut watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    watch.assert_unchanged();
    assert_eq!(fs::read_to_string(&reads)?, before);
    account(&s, &id, "connected").await?;
    eprintln!(
        "PC3: 60 s, connected accounts=1, unsolicited resource reads=0, disk writes=0 bytes; idle session awaits Notify/child/call, no timer"
    );
    drop(watch);
    s.finish().await
}

#[tokio::test]
async fn pc1_safe_mode_starts_zero_account_children() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC1-SAFE")?;
    let root = package(&setup.sandbox.home, false)?;
    let mut s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    let starts = data(&s).join(format!("{id}-starts"));
    let before = fs::read_to_string(&starts)?;
    fs::create_dir_all(s.sandbox.data.join("state"))?;
    fs::write(
        s.sandbox.data.join("state/plugin-safe-mode-once.json"),
        "{\"safe_mode\":true}",
    )?;
    s.restart().await?;
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["safe_mode"],
        true
    );
    account(&s, &id, "disconnected").await?;
    assert_eq!(fs::read_to_string(starts)?, before);
    s.finish().await
}
