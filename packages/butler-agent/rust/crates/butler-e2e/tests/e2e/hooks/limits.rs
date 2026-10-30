use super::*;
#[tokio::test]
async fn hooks_full_large_response_and_nonmatching_handlers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-LARGE")?.stub_cassette(Cassette::load("TOOL-01")?);
    let content = "한글 and exact bytes ".repeat(35000);
    for name in ["large-a.txt", "large-b.txt"] {
        fs::write(setup.sandbox.data.join(name), &content)?;
    }
    let mut hooks = vec![observer(&setup, "PostToolUse")];
    for index in 0..16 {
        let mut h = hook(&format!("unmatched-{index}"), "PreToolUse", "exit 2");
        h["match"] = json!({"tools":["mcp__never__*"]});
        hooks.push(h);
    }
    configure(&setup, &hooks)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(stub::large);
    let (_, turn) = s.turn("general", "Read both large files exactly.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let captured = payloads(&s.sandbox.home);
    assert_eq!(captured.len(), 1);
    let output = &captured[0]["tool_response"];
    assert!(output.to_string().len() > 1_048_576);
    let files = output["files"].as_array().unwrap();
    assert_eq!(files.len(), 2, "{output}");
    for file in files {
        assert_eq!(file["content"], content);
        assert_eq!(file["truncated"], false);
    }
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert_eq!(runs.data().as_array().unwrap().len(), 1);
    s.finish().await
}
#[tokio::test]
async fn hooks_revision_invalid_reload_and_output_caps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("HOOK-LIMITS")?.start().await?;
    let echo = if command_sandbox::POSIX_SHELL {
        "printf okay"
    } else {
        "echo okay"
    };
    replace(&s, vec![hook("test", "PreToolUse", echo)]).await?;
    let stale = api(
        &s,
        Method::PUT,
        "/hooks",
        Some(json!({"revision":0,"config":{"version":1,"hooks":[]}})),
    )
    .await?;
    assert_eq!(stale.status, 409);
    fs::write(s.sandbox.data.join("hooks.json"), "invalid file")?;
    s.turn("general", "Reload invalid config.").await?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert!(settings.data()["error"].is_string());
    assert_eq!(settings.data()["config"]["hooks"][0]["id"], "test");
    let tested = api(&s, Method::POST, "/hooks/test/test", Some(json!({}))).await?;
    assert_eq!(tested.status, 200);
    assert_eq!(tested.data()["outcome"], "continue");
    let flood = if command_sandbox::POSIX_SHELL {
        "head -c 65537 /dev/zero"
    } else {
        "powershell -NoProfile -Command \"[Console]::Write(('x' * 65537))\""
    };
    replace(&s, vec![hook("flood", "UserPromptSubmit", flood)]).await?;
    assert_eq!(
        s.turn("general", "Output cap fails open.").await?.1["state"],
        "delivered"
    );
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert_eq!(
        runs.data().as_array().unwrap().last().unwrap()["outcome"],
        "error"
    );
    s.finish().await
}
#[tokio::test]
async fn hooks_unsupported_type_is_refused_and_never_stops_the_agent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("HOOK-UNSUPPORTED-TYPE")?;
    let with_url = json!({"id":"web","event":"Stop","type":"http",
        "url":"https://hooks.invalid/private-path","timeout_ms":1000});
    configure(&setup, std::slice::from_ref(&with_url))?;
    let s = setup.start().await?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert_eq!(settings.status, 200, "{settings:?}");
    let error = settings.data()["error"].as_str().unwrap();
    assert!(error.contains("unknown field `url`"), "{error}");
    assert!(!error.contains("hooks.invalid"), "{error}");
    assert_eq!(settings.data()["config"]["hooks"], json!([]));
    assert_eq!(
        s.turn("general", "Runs without the hook.").await?.1["state"],
        "delivered"
    );
    let bare = json!({"id":"web","event":"Stop","type":"http","timeout_ms":1000});
    fs::write(
        s.sandbox.data.join("hooks.json"),
        json!({"version":1,"hooks":[bare]}).to_string(),
    )?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert_eq!(
        settings.data()["error"],
        "Only command hooks accepting schema 1 are supported"
    );
    let revision = settings.data()["revision"].clone();
    let config = |hook: &Value| json!({"version":1,"hooks":[hook]});
    let saved = api(
        &s,
        Method::PUT,
        "/hooks",
        Some(json!({"revision":revision,"config":config(&bare)})),
    )
    .await?;
    assert_eq!(saved.status, 400, "{saved:?}");
    assert_eq!(saved.error_code(), Some("hook_invalid"));
    for body in [
        json!({"revision":revision,"config":config(&with_url)}),
        json!({"revision":revision,"config":{"version":1,"hooks":[]},"secrets":{"web":"0123456789abcdef"}}),
    ] {
        let saved = api(&s, Method::PUT, "/hooks", Some(body)).await?;
        assert_eq!(saved.status, 400, "{saved:?}");
    }
    replace(&s, vec![hook("ok", "Stop", "exit 0")]).await?;
    let settings = api(&s, Method::GET, "/hooks", None).await?;
    assert!(settings.data()["error"].is_null(), "{settings:?}");
    assert_eq!(settings.data()["config"]["hooks"][0]["id"], "ok");
    s.finish().await
}
#[tokio::test]
async fn hooks_allow_cannot_bypass_permission_and_resume_preserves_id() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-AUTHORITY")?
        .stub_cassette(Cassette::load("ACC-07")?)
        .access(Access::AskAlways);
    let allow = if command_sandbox::POSIX_SHELL {
        "printf '{\"decision\":\"allow\"}'"
    } else {
        "echo {\"decision\":\"allow\"}"
    };
    let mut observed = observer(&setup, "PreToolUse");
    observed["id"] = json!("observe");
    observed["match"] = json!({"tools":["set_wallpaper"]});
    let mut guard = hook("allow", "PreToolUse", allow);
    guard["match"] = json!({"tools":["set_wallpaper"]});
    let mut post = observer(&setup, "PostToolUse");
    post["match"] = json!({"tools":["set_wallpaper"]});
    let mut fresh = observer(&setup, "PreToolUse");
    fresh["id"] = json!("fresh");
    fresh["match"] = json!({"tools":["record_work_disposition"]});
    configure(&setup, &[observed, guard, post, fresh])?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(stub::wallpaper);

    let accepted =
        s.gw.say(
            "general",
            "Change my App wallpaper to the Silk live wallpaper, app-wide.",
        )
        .await?;
    let id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(30),
        )
        .await?;
    assert_eq!(turn["state"], "waiting_for_form", "{turn}");
    assert!(!s.sandbox.home.join("tool-ran").exists());
    let requests = s.gw.approval_requests("general").await?;
    assert_eq!(requests.len(), 1);
    let reference = requests[0]["request_ref"]
        .as_str()
        .or_else(|| requests[0]["ref"].as_str())
        .unwrap();
    let accepted =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(accepted.status, 202);
    let settled =
        s.gw.wait_turn(
            "general",
            &id,
            &["delivered", "failed"],
            Duration::from_secs(30),
        )
        .await?;
    assert_eq!(settled["state"], "delivered", "{settled}");
    let all = payloads(&s.sandbox.home);
    assert_eq!(
        all.iter()
            .filter(|p| p["hook_event_name"] == "PostToolUse")
            .count(),
        1
    );
    let captured: Vec<_> = all
        .iter()
        .filter(|p| p["hook_event_name"] == "PreToolUse")
        .collect();
    assert_eq!(captured.len(), 3);
    assert_eq!(captured[0]["event_id"], captured[1]["event_id"]);
    assert_eq!(captured[0]["tool_use_id"], captured[1]["tool_use_id"]);
    assert_eq!(captured[0]["resumed"], false);
    assert_eq!(captured[1]["resumed"], true);
    assert_eq!(captured[2]["tool_use_id"], "hook_close");
    assert_eq!(captured[2]["resumed"], false);
    assert_eq!(
        s.gw.settings().await?["wallpaper"]["source"]["module"],
        "butler.silk"
    );
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert_eq!(
        runs.data()
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["outcome"] == "approval_ignored")
            .count(),
        2
    );
    s.finish().await
}
#[tokio::test]
async fn hooks_allow_cannot_enable_read_only_write() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-READONLY")?
        .stub_cassette(Cassette::load("ACC-07")?)
        .access(Access::FullAccess);
    let allow = if command_sandbox::POSIX_SHELL {
        "printf '{\"decision\":\"allow\"}'"
    } else {
        "echo {\"decision\":\"allow\"}"
    };
    configure(&setup, &[hook("allow", "PreToolUse", allow)])?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(stub::wallpaper_readonly);
    s.patch_settings(json!({"access_mode":"read_only"}), "access")
        .await?;
    let before = s.gw.settings().await?["wallpaper"].clone();
    let (_, turn) = s
        .turn(
            "general",
            "Change my App wallpaper to the Silk live wallpaper, app-wide.",
        )
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert_eq!(s.gw.settings().await?["wallpaper"], before);
    assert_eq!(
        s.gw.approval_requests("general").await?,
        [] as [serde_json::Value; 0]
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("read_only"))
    );
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(
        runs.data()
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["outcome"] == "approval_ignored")
    );
    s.finish().await
}
