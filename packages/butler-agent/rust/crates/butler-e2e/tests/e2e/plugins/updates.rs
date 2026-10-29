use super::{git_support::*, *};
use std::{io::Write, time::Duration};

#[tokio::test]
async fn pg9_silent_update_keeps_inflight_digest_and_pg11_rollback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = git_setup("PG9")?;
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    edit(&repo.work.join("mcp.json"), |v| {
        v["mcpServers"]["notes"]["env"]["E2E_MCP_DELAY_MS"] = json!("1500");
        v["mcpServers"]["notes"]["env"]["E2E_MCP_CALL_STARTED_FILE"] =
            json!("${BUTLER_PLUGIN_DATA}/call-started");
    });
    repo.publish();
    let s = setup.start().await?;
    let first = install_source(&s, json!({"git":repo.url,"ref":"main"})).await?;
    repo.version("1.2.4");
    repo.nonce("updated-output");
    fs::write(
        repo.work.join("skills/notes/SKILL.md"),
        "---\nname: notes\ndescription: Updated package notes\n---\nUpdated skill instructions.\n",
    )?;
    fs::OpenOptions::new()
        .append(true)
        .open(repo.work.join("server.exe"))?
        .write_all(b"\npackage revision\n")?;
    repo.publish();
    s.provider()?.set_chat_responder(respond);
    let accepted = s.gw.say("general", "Call the old package tool.").await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let marker = s.sandbox.data.join("plugins/data/helper/call-started");
    tokio::time::timeout(Duration::from_secs(20), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("slow call never started");
    let result = check(&s, true).await?;
    assert_eq!(result["status"], "update_available", "{result}");
    assert_eq!(result["applied"], true);
    assert_eq!(result["previous_version"], "1.2.3");
    let p = inventory(&s).await?;
    assert_eq!(p["version"], "1.2.4");
    assert_ne!(p["content_digest"], first["digest"]);
    assert!(
        s.sandbox
            .data
            .join("plugins/store")
            .join(first["digest"].as_str().unwrap())
            .is_dir()
    );
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(done["state"], "delivered", "{done}");
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|v| v.to_string().contains("e2e token package-output"))
    );
    let events = s.gw.events_since(0).await?;
    assert!(events.iter().any(|e| e["type"] == "plugins.changed"
        && e["payload"]["version"] == "1.2.4"
        && e["payload"]["previous_version"] == "1.2.3"));
    echo(&s, "updated-output").await?;
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|v| v.to_string().contains("Updated skill instructions."))
    );
    let r = api(
        &s,
        Method::POST,
        "/plugins/helper/rollback",
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(inventory(&s).await?["content_digest"], first["digest"]);
    echo(&s, "package-output").await?;
    s.finish().await
}

#[tokio::test]
async fn local_folder_updates_and_registry_checks_resolve_latest_entry() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = git_setup("PG-LOCAL-REGISTRY")?;
    let local = package(&setup.sandbox.home, "helper")?;
    let repo = Repo::new(&setup.sandbox.home, "remote-helper", false)?;
    // Copy the package through its own source snapshot, preserving its manifest name.
    repo.git(
        &repo.work,
        &["--work-tree", local.to_str().unwrap(), "add", "--all"],
    );
    repo.git(&repo.work, &["commit", "-m", "Initial package"]);
    repo.git(&repo.work, &["push", "origin", "main"]);
    repo.git(&repo.work, &["reset", "--hard", "HEAD"]);
    let registry = Repo::new(&setup.sandbox.home, "team", false)?;
    fs::write(
        registry.work.join("butler-registry.json"),
        json!([{"name":"helper","git":repo.url,"ref":"main"}]).to_string(),
    )?;
    registry.publish();
    let s = setup.start().await?;
    install(&s, &local).await?;
    edit(&local.join("plugin.json"), |v| {
        v["version"] = json!("1.3.0");
    });
    assert_eq!(check(&s, true).await?["applied"], true);
    assert_eq!(inventory(&s).await?["version"], "1.3.0");
    let r = api(
        &s,
        Method::DELETE,
        &format!("/plugins/helper?revision={}", revision(&s).await?),
        None,
    )
    .await?;
    assert_eq!(r.status, 200);
    let r = api(
        &s,
        Method::POST,
        "/plugin-registries",
        Some(json!({"url":registry.url,"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    let id = r.data()["id"].clone();
    install_source(&s, json!({"registry":id,"name":"helper"})).await?;
    repo.version("2.0.0");
    let sha = repo.publish();
    edit(&registry.work.join("butler-registry.json"), |v| {
        v[0]["commit"] = json!(sha);
        v[0].as_object_mut().unwrap().remove("ref");
    });
    let registry_sha = registry.publish();
    assert_eq!(check(&s, true).await?["applied"], true);
    assert_eq!(inventory(&s).await?["pin"]["registry_commit"], registry_sha);
    echo(&s, "package-output").await?;
    let r = api(
        &s,
        Method::DELETE,
        &format!(
            "/plugin-registries/{}?revision={}",
            id.as_str().unwrap(),
            revision(&s).await?
        ),
        None,
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    s.finish().await
}

#[tokio::test]
async fn silent_narrowing_keeps_templates_and_verifies_the_new_digest() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = git_setup("PG-COVERAGE-VERIFY")?;
    let root = package(&setup.sandbox.home, "helper")?;
    let set_scope = |path: &str, access: &str| {
        edit(&root.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["capabilities"] =
                json!({"files":[{"path":path,"access":access}]});
        });
    };
    set_scope("/workspace", "read_write");
    let s = setup.start().await?;
    install(&s, &root).await?;
    echo(&s, "package-output").await?;
    set_scope("/workspace/notes", "read");
    assert_eq!(check(&s, true).await?["applied"], true);
    let p = inventory(&s).await?;
    assert_eq!(
        p["capabilities"]["files"],
        json!([{"path":"/workspace/notes","access":"read"}])
    );
    assert!(
        p["capabilities"]["runs_on_this_computer"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["argv"][0] == "${BUTLER_PLUGIN_ROOT}/server.exe")
    );
    set_scope("/workspace/notes-other", "read");
    assert_eq!(check(&s, true).await?["status"], "needs_review");
    let store = s
        .sandbox
        .data
        .join("plugins/store")
        .join(p["content_digest"].as_str().unwrap());
    butler_platform::plugin_files::protect(&store, false)?;
    fs::write(store.join("skills/notes/SKILL.md"), "tampered after swap")?;
    let _ = s.gw.get("/mcp-capabilities").await?;
    assert_eq!(inventory(&s).await?["quarantine"], "changed_on_disk");
    s.finish().await
}
