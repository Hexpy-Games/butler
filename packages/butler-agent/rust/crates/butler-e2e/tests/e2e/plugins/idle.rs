use super::*;
use std::time::Duration;
#[tokio::test]
async fn perf_pg6_idle_registry_is_complete_and_has_zero_plugin_writes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("PG6-IDLE")?;
    let mut roots = Vec::new();
    for n in 0..10 {
        roots.push(package(&setup.sandbox.home, &format!("helper-{n}"))?);
    }
    let s = setup.start().await?;
    for root in roots {
        install(&s, &root).await?;
    }
    let watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    watch.assert_subtree_unchanged(Path::new("plugins"))?;
    let view = api(&s, Method::GET, "/plugins", None).await?;
    let plugins = view.data()["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 10);
    for n in 0..10 {
        assert!(plugins.iter().any(|p| p["id"] == format!("helper-{n}")
            && p["enabled"] == true
            && p["quarantine"].is_null()));
    }
    for n in 0..10 {
        assert!(
            !s.sandbox
                .data
                .join(format!("plugins/data/helper-{n}/hook-ran"))
                .exists()
        );
    }
    for n in 0..10 {
        assert!(
            !s.sandbox
                .data
                .join(format!("plugins/data/helper-{n}/mcp-started"))
                .exists()
        );
    }
    eprintln!("PG6: 10 plugins, 60 s, plugin writes=0, hook spawns=0, inventory=10/10");
    drop(watch);
    s.finish().await
}
#[tokio::test]
async fn perf_pg6_registry_startup_p95_with_100_plugins() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG6-STARTUP")?;
    let mut s = setup.start().await?;
    let baseline = measure(&mut s, 0).await?;
    for n in 0..100 {
        let root = s.sandbox.home.join(format!("plugin-{n}"));
        fs::create_dir_all(&root)?;
        fs::write(
            root.join("plugin.json"),
            json!({"name":format!("plugin-{n}"),"version":"1.0.0"}).to_string(),
        )?;
        install(&s, &root).await?;
    }
    let loaded = measure(&mut s, 100).await?;
    eprintln!(
        "PG6: registry startup p95 zero={baseline} us, 100={loaded} us, growth={} us, inventory=100/100",
        loaded.saturating_sub(baseline)
    );
    assert!(loaded.saturating_sub(baseline) <= 50_000);
    s.finish().await
}
async fn measure(s: &mut Scenario, count: usize) -> Result<u64, HarnessError> {
    let mut timings = Vec::new();
    for _ in 0..5 {
        s.restart().await?;
        let list = api(s, Method::GET, "/plugins", None).await?;
        let inventory = list.data()["plugins"].as_array().unwrap();
        assert_eq!(inventory.len(), count);
        let mut expected = (0..count)
            .map(|n| format!("plugin-{n}"))
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(
            inventory
                .iter()
                .map(|p| p["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(
            inventory
                .iter()
                .all(|p| p["enabled"] == true && p["quarantine"].is_null())
        );
        let log = s.agent.current_logs().await?;
        let line = log
            .lines()
            .find(|l| l.contains("phase=plugins_registry "))
            .unwrap();
        let duration = line
            .split_whitespace()
            .find_map(|w| w.strip_prefix("duration_us="))
            .unwrap()
            .parse::<u64>()
            .unwrap();
        timings.push(duration);
    }
    timings.sort_unstable();
    Ok(*timings.last().unwrap())
}
