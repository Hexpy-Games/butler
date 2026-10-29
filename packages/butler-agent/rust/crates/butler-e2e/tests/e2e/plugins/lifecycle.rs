use super::*;
#[tokio::test]
async fn pg1_inspect_installs_nothing_then_skill_mcp_hook_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG1")?;
    let folder = package(&setup.sandbox.home, "helper")?;
    let s = setup.start().await?;
    let i = inspect(&s, &folder).await?;
    assert_eq!(i["capabilities"]["skills"], json!(["helper:notes"]));
    assert_eq!(i["capabilities"]["agent_tools"], json!(["helper/notes"]));
    assert_eq!(i["capabilities"]["hooks"][0]["event"], "PreToolUse");
    assert_eq!(i["notice"], "runs_with_your_permissions");
    let store = s
        .sandbox
        .data
        .join("plugins/store")
        .join(i["digest"].as_str().unwrap());
    assert_eq!(
        i["capabilities"]["runs_on_this_computer"][0]["argv"][0],
        store.join("server.exe").to_string_lossy().as_ref()
    );
    assert!(!store.exists());
    assert!(
        !s.sandbox
            .data
            .join("plugins/data/helper/mcp-started")
            .exists()
    );
    assert!(!s.sandbox.data.join("plugins/data/helper/hook-ran").exists());
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["plugins"],
        json!([])
    );
    let r = api(
        &s,
        Method::POST,
        "/plugins/install",
        Some(json!({"staging_id":i["staging_id"],"digest":i["digest"],"revision":0,"secrets":{}})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    s.provider()?.set_chat_responder(stub::run);
    let (_, turn) = s.turn("general", "Use the package skill and tool.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("Package skill instructions."))
    );
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("package-output")),
        "tool did not return its output"
    );
    assert!(s.sandbox.data.join("plugins/data/helper/hook-ran").exists());
    let servers = s.gw.get("/mcp-servers").await?;
    assert!(
        servers.data()["servers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "helper/notes" && s["source"] == "plugin")
    );
    let refused = s.gw.delete("/mcp-servers/helper%2Fnotes").await?;
    assert_eq!(refused.status, 400);
    s.finish().await
}
#[tokio::test]
async fn pg2_allow_hook_cannot_bypass_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG2")?.access(butler_e2e::e2e::scenario::Access::AskAlways);
    let folder = package(&setup.sandbox.home, "helper")?;
    let s = setup.start().await?;
    install(&s, &folder).await?;
    s.provider()?.set_chat_responder(stub::run);
    let accepted = s.gw.say("general", "Use the package tool.").await?;
    let turn_id = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let states = butler_e2e::e2e::gateway::TERMINAL
        .iter()
        .copied()
        .chain(["waiting_for_form"])
        .collect::<Vec<_>>();
    let turn =
        s.gw.wait_turn(
            "general",
            &turn_id,
            &states,
            std::time::Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
        )
        .await?;
    assert_eq!(turn["state"], "waiting_for_form", "{turn}");
    let cards = s.gw.approval_requests("general").await?;
    assert!(
        cards
            .iter()
            .any(|c| c["approval"]["operation"]["targets"] == json!(["mcp:helper/notes/e2e_echo"])),
        "{cards:?}"
    );
    s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
        .await?;
    let logs = s.gw.get("/logs?q=approval_ignored").await?;
    assert_eq!(logs.status, 200, "{logs:?}");
    assert!(
        logs.data()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["event"] == "approval_ignored"
                && r["attrs"]["scope"] == "plugin"
                && r["attrs"]["hook_id"] == "helper/allow")
    );
    s.finish().await
}
#[tokio::test]
async fn pg3_disable_and_uninstall_remove_components_keep_data_unless_requested()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG3")?;
    let folder = package(&setup.sandbox.home, "helper")?;
    let s = setup.start().await?;
    let i = install(&s, &folder).await?;
    let stale = api(
        &s,
        Method::POST,
        "/plugins/helper/disable",
        Some(json!({"revision":0})),
    )
    .await?;
    assert_eq!(stale.status, 409);
    let disabled = api(
        &s,
        Method::POST,
        "/plugins/helper/disable",
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(disabled.status, 200, "{disabled:?}");
    assert_eq!(s.gw.get("/mcp-servers").await?.data()["servers"], json!([]));
    s.provider()?.set_chat_responder(stub::run);
    let (_, turn) = s.turn("general", "Try the disabled package.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(
        !s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("Package skill instructions."))
    );
    assert!(!s.sandbox.data.join("plugins/data/helper/hook-ran").exists());
    let r = api(
        &s,
        Method::DELETE,
        &format!(
            "/plugins/helper?data=false&revision={}",
            revision(&s).await?
        ),
        None,
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(
        !s.sandbox
            .data
            .join("plugins/store")
            .join(i["digest"].as_str().unwrap())
            .exists()
    );
    assert!(s.sandbox.data.join("plugins/data/helper").is_dir());
    install(&s, &folder).await?;
    let r = api(
        &s,
        Method::DELETE,
        &format!("/plugins/helper?data=true&revision={}", revision(&s).await?),
        None,
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(!s.sandbox.data.join("plugins/data/helper").exists());
    s.finish().await
}
#[tokio::test]
async fn pg5_safe_mode_has_no_components_and_normal_restart_restores_them()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG5")?;
    let folder = package(&setup.sandbox.home, "helper")?;
    let mut s = setup.start().await?;
    install(&s, &folder).await?;
    s.agent.launch.service_args.push("--safe-mode".into());
    s.restart().await?;
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["safe_mode"],
        true
    );
    assert_eq!(s.gw.get("/mcp-servers").await?.data()["servers"], json!([]));
    assert!(!s.sandbox.data.join("plugins/data/helper/hook-ran").exists());
    s.agent.launch.service_args.clear();
    s.restart().await?;
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["safe_mode"],
        false
    );
    assert_eq!(
        s.gw.get("/mcp-servers").await?.data()["servers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    s.finish().await
}

#[tokio::test]
async fn pg2_read_only_denies_plugin_mcp_effects() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG2-READONLY")?;
    let root = package(&setup.sandbox.home, "helper")?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    s.patch_settings(json!({"access_mode":"read_only"}), "access")
        .await?;
    s.provider()?.set_chat_responder(stub::run);
    let (_, turn) = s
        .turn("general", "Use the plugin tool in read-only mode.")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(
        !s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("package-output"))
    );
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    s.finish().await
}

#[tokio::test]
async fn plugin_hook_deduplication_keeps_distinct_package_roots() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-HOOK-NAMESPACE")?;
    let first = package(&setup.sandbox.home, "helper")?;
    let second = package(&setup.sandbox.home, "second-helper")?;
    let s = setup.start().await?;
    install(&s, &first).await?;
    install(&s, &second).await?;
    s.provider()?.set_chat_responder(stub::run);
    assert_eq!(
        s.turn("general", "Use both packages' hook scopes.")
            .await?
            .1["state"],
        "delivered"
    );
    for id in ["helper", "second-helper"] {
        assert!(
            s.sandbox
                .data
                .join("plugins/data")
                .join(id)
                .join("hook-ran")
                .is_file(),
            "missing hook for {id}"
        );
    }
    s.finish().await
}

#[tokio::test]
async fn plugin_skill_allowed_tools_cannot_grant_command_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-SKILL-APPROVAL")?.access(butler_e2e::e2e::scenario::Access::AskAlways);
    let root = package(&setup.sandbox.home, "helper")?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    s.provider()?.set_chat_responder(stub::command);
    let accepted =
        s.gw.say("general", "Load the plugin skill and run its command.")
            .await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let states = butler_e2e::e2e::gateway::TERMINAL
        .iter()
        .copied()
        .chain(["waiting_for_form"])
        .collect::<Vec<_>>();
    let settled =
        s.gw.wait_turn(
            "general",
            &turn,
            &states,
            std::time::Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
        )
        .await?;
    assert_eq!(settled["state"], "waiting_for_form", "{settled}");
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("Package skill instructions."))
    );
    let cards = s.gw.approval_requests("general").await?;
    assert!(
        cards.iter().any(
            |c| c["executable"] == "run_command" && c.to_string().contains("echo plugin-skill")
        ),
        "{cards:?}"
    );
    s.finish().await
}
