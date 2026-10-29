use super::*;
#[tokio::test]
async fn pg4_rejections_clean_staging_and_tampering_quarantines() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG4")?;
    let folder = package(&setup.sandbox.home, "helper")?;
    let s = setup.start().await?;
    let untrusted =
        s.gw.post("/plugins/inspect", json!({"path":folder}))
            .await?;
    assert_eq!(untrusted.status, 403);
    let original = fs::read(folder.join("plugin.json"))?;
    let mut bad: Value = serde_json::from_slice(&original)?;
    for path in [
        "../outside",
        "/outside",
        "a/../outside",
        "a\\outside",
        "C:outside",
    ] {
        bad["skills"] = json!([path]);
        fs::write(folder.join("plugin.json"), bad.to_string())?;
        let r = api(
            &s,
            Method::POST,
            "/plugins/inspect",
            Some(json!({"path":folder})),
        )
        .await?;
        assert_eq!(r.status, 400, "{path}: {r:?}");
        assert_empty(&s, "staging")?;
    }
    fs::write(folder.join("plugin.json"), &original)?;
    butler_platform::secure_fs::symlink(&folder.join("plugin.json"), &folder.join("linked"))?;
    let r = api(
        &s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"path":folder})),
    )
    .await?;
    assert_eq!(r.status, 400);
    assert_empty(&s, "staging")?;
    fs::remove_file(folder.join("linked"))?;
    let i = inspect(&s, &folder).await?;
    let mismatch = api(
        &s,
        Method::POST,
        "/plugins/install",
        Some(json!({"staging_id":i["staging_id"],"digest":"wrong","revision":0,"secrets":{}})),
    )
    .await?;
    assert_eq!(mismatch.status, 400);
    assert_empty(&s, "store")?;
    let i = install(&s, &folder).await?;
    let store = s
        .sandbox
        .data
        .join("plugins/store")
        .join(i["digest"].as_str().unwrap());
    butler_platform::plugin_files::protect(&store, false)?;
    fs::write(store.join("skills/notes/SKILL.md"), "changed")?;
    let _ = s.gw.get("/mcp-capabilities").await?;
    let view = api(&s, Method::GET, "/plugins", None).await?;
    assert_eq!(view.data()["plugins"][0]["quarantine"], "changed_on_disk");
    assert_eq!(s.gw.get("/mcp-servers").await?.data()["servers"], json!([]));
    assert!(!s.sandbox.data.join("plugins/data/helper/hook-ran").exists());
    s.finish().await
}
pub(super) fn assert_empty(s: &Scenario, subdir: &str) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("plugins").join(subdir);
    if path.exists() {
        assert_eq!(fs::read_dir(path)?.count(), 0);
    }
    Ok(())
}
#[tokio::test]
async fn compatibility_and_secret_fields_never_disclose_values() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PG-COMPAT")?;
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    let folder = package(&setup.sandbox.home, "helper")?;
    fs::create_dir(folder.join(".claude-plugin"))?;
    fs::write(folder.join(".claude-plugin/plugin.json"),json!({"name":"helper","version":"1.2.3","skills":"./skills","commands":"./commands","mcpServers":"./.mcp.json"}).to_string())?;
    fs::remove_file(folder.join("plugin.json"))?;
    fs::write(folder.join(".mcp.json"),json!({"mcpServers":{"Notes_API":{"command":"${CLAUDE_PLUGIN_ROOT}/server.exe","env":{"PRIVATE_TOKEN":"${PRIVATE_TOKEN}","E2E_MCP_REQUIRE_SECRET":"PRIVATE_TOKEN"}}}}).to_string())?;
    fs::remove_file(folder.join("mcp.json"))?;
    let canary = format!("plugin-secret-{}", uuid::Uuid::new_v4());
    let mut config: Value = serde_json::from_slice(&fs::read(folder.join(".mcp.json"))?)?;
    use sha2::{Digest, Sha256};
    config["mcpServers"]["Notes_API"]["env"]["E2E_MCP_ENV_SHA256"] = json!(
        json!({"PRIVATE_TOKEN":format!("{:x}",Sha256::digest(canary.as_bytes()))}).to_string()
    );
    config["mcpServers"]["Notes_API"]["env"]["E2E_MCP_FORBIDDEN_ENV"] =
        json!("BUTLER_DATA,BUTLER_APP_LOCAL_AUTH_TOKEN,OPENAI_API_KEY");
    config["mcpServers"]["Notes_API"]["env"]["E2E_MCP_REQUIRE_SECRET"] =
        json!("PRIVATE_TOKEN,BUTLER_PLUGIN_ROOT,CLAUDE_PLUGIN_ROOT,BUTLER_PLUGIN_DATA");
    fs::write(folder.join(".mcp.json"), config.to_string())?;
    let s = setup.start().await?;
    let i = inspect(&s, &folder).await?;
    assert_eq!(
        i["capabilities"]["secrets"],
        json!([{"key":"PRIVATE_TOKEN","label":"PRIVATE_TOKEN"}])
    );
    assert!(
        i["compatibility"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["component"] == "commands" && v["status"] == "unsupported")
    );
    let r=api(&s,Method::POST,"/plugins/install",Some(json!({"staging_id":i["staging_id"],"digest":i["digest"],"revision":0,"secrets":{"PRIVATE_TOKEN":canary}}))).await?;
    assert_eq!(r.status, 200);
    let caps = s.gw.get("/mcp-capabilities").await?;
    assert_eq!(caps.data()["servers"][0]["id"], "helper/notes_api");
    assert_eq!(
        caps.data()["servers"][0]["ok"],
        true,
        "MCP did not receive the approved secret"
    );
    let key = butler_platform::secrets::SecretKey::new(
        "io.github.hexpy-games.butler.plugins",
        "helper/PRIVATE_TOKEN",
    )
    .unwrap();
    assert!(
        butler_platform::secrets::isolated_system_secret_present_for_test(&s.sandbox.home, &key)?
    );
    assert!(!s.sandbox.data.join("secrets/plugins.json").exists());
    assert!(!i.to_string().contains(&canary));
    assert!(
        !api(&s, Method::GET, "/plugins", None)
            .await?
            .text
            .contains(&canary)
    );
    assert!(!fs::read_to_string(s.sandbox.data.join("plugins/registry.json"))?.contains(&canary));
    scan_logs(&s.sandbox.data, &canary)?;
    scan_logs(&s.sandbox.logs, &canary)?;
    s.finish().await
}
fn scan_logs(root: &Path, canary: &str) -> Result<(), HarnessError> {
    for e in fs::read_dir(root)? {
        let path = e?.path();
        if path.is_dir() {
            scan_logs(&path, canary)?;
        } else if path.extension().is_some_and(|e| e == "log" || e == "jsonl") {
            assert!(!String::from_utf8_lossy(&fs::read(path)?).contains(canary));
        }
    }
    Ok(())
}
#[tokio::test]
async fn pg7_project_manifests_never_install_or_contribute_components() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = setup("PG7")?;
    let folder = package(&setup.sandbox.home.join("butler-workspace"), "helper")?;
    fs::create_dir(folder.join(".claude-plugin"))?;
    fs::copy(
        folder.join("plugin.json"),
        folder.join(".claude-plugin/plugin.json"),
    )?;
    let s = setup.start().await?;
    let r =
        s.gw.post(
            "/projects",
            json!({"source":"workspace_folder","workspace_path":"helper"}),
        )
        .await?;
    assert!(r.status < 300, "{r:?}");
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","project_id":r.data()["project"]["id"]}),
        )
        .await?;
    assert_eq!(session.status, 201, "{session:?}");
    let chat = session.data()["session"]["id"].as_str().unwrap();
    s.provider()?.set_chat_responder(stub::run);
    assert_eq!(
        s.turn(chat, "Check the project catalog.").await?.1["state"],
        "delivered"
    );
    assert_eq!(
        api(&s, Method::GET, "/plugins", None).await?.data()["plugins"],
        json!([])
    );
    assert_eq!(s.gw.get("/mcp-servers").await?.data()["servers"], json!([]));
    s.finish().await
}
