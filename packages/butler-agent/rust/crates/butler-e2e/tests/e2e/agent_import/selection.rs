//! Item discovery, partial imports and their exact receipts through the host API.
use super::*;

#[tokio::test]
async fn agent_import_selects_items_and_undoes_only_selected_items() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("AGENT-IMPORT-SELECTION")?.fixture(Fixture::Empty);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    agent_homes(&setup.sandbox.home);
    let s = setup.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let reply = admin
        .send(Method::GET, "/security/agent-import/sources", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    assert!(
        !reply.text.contains("canary"),
        "source response leaked a secret"
    );
    let rows = reply.data()["sources"].as_array().unwrap();
    for (key, label, expected) in [
        (
            "codex",
            "~/.codex/AGENTS.override.md",
            json!([
                {"name":"files", "needs_secret":false}, {"name":"github", "needs_secret":true}
            ]),
        ),
        (
            "claude-code",
            "~/.claude/CLAUDE.md",
            json!([
                {"name":"files", "needs_secret":false}, {"name":"remote", "needs_secret":true}
            ]),
        ),
        (
            "opencode",
            "~/.config/opencode/AGENTS.md",
            json!([
                {"name":"clock", "needs_secret":true}
            ]),
        ),
        (
            "hermes",
            "~/.hermes/SOUL.md",
            json!([
                {"name":"fetch", "needs_secret":false}, {"name":"github", "needs_secret":true}
            ]),
        ),
    ] {
        let row = rows.iter().find(|row| row["key"] == key).unwrap();
        assert_eq!(row["items"]["instructions"], json!([label]));
        let mut servers = row["items"]["servers"].as_array().unwrap().clone();
        servers.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        assert_eq!(json!(servers), expected);
    }
    let instruction = call(
        &admin,
        "start",
        Some(json!({"source":"codex", "servers":[]})),
    )
    .await?;
    assert_eq!(instruction["instructions"], 1);
    assert_eq!(instruction["servers"], 0);
    assert_eq!(instructions(&s).await?.len(), 1);
    assert_eq!(servers(&s).await?, Vec::<Value>::new());
    let selected = call(
        &admin,
        "start",
        Some(json!({
            "source":"codex", "instructions":false, "servers":["github", "github"]
        })),
    )
    .await?;
    assert_eq!(selected["instructions"], 0);
    assert_eq!(selected["instructions_existing"], 0);
    assert_eq!(selected["servers"], 1);
    assert_eq!(selected["servers_existing"], 0);
    assert_eq!(selected["needs_secret"], 1);
    let rows = servers(&s).await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], "github");
    assert_no_secrets(&s).await?;
    let undone = call(&admin, "undo", Some(json!({"run_id":selected["run_id"]}))).await?;
    assert_eq!(undone, json!({"instructions":0, "servers":1}));
    assert_eq!(instructions(&s).await?.len(), 1);
    assert_eq!(servers(&s).await?, Vec::<Value>::new());
    let all_servers = call(
        &admin,
        "start",
        Some(json!({"source":"codex", "instructions":false})),
    )
    .await?;
    assert_eq!(all_servers["instructions"], 0);
    assert_eq!(all_servers["servers"], 2);
    let undone = call(
        &admin,
        "undo",
        Some(json!({"run_id":instruction["run_id"]})),
    )
    .await?;
    assert_eq!(undone, json!({"instructions":1, "servers":0}));
    assert_eq!(instructions(&s).await?, Vec::<String>::new());
    assert_eq!(servers(&s).await?.len(), 2);
    let defaults = start(&admin, "codex").await?;
    assert_eq!(defaults["instructions"], 1);
    assert_eq!(defaults["servers_existing"], 2);
    s.finish().await
}

#[tokio::test]
async fn agent_import_rejects_invalid_selection_before_writing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("AGENT-IMPORT-INVALID-SELECTION")?.fixture(Fixture::Empty);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    memory_fixture::initialize_empty(&setup.sandbox.data)?;
    agent_homes(&setup.sandbox.home);
    let s = setup.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    for fields in [
        json!({"servers":["github", "unknown"]}),
        json!({"servers":[42]}),
        json!({"servers":"github"}),
        json!({"instructions":"false"}),
        json!({"instructions":null}),
    ] {
        let mut body = fields;
        body["source"] = json!("codex");
        let reply = admin
            .send(
                Method::POST,
                "/security/agent-import/start",
                Some(body),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert_eq!(reply.body["error"]["code"], "invalid_import_request");
        assert_eq!(instructions(&s).await?, Vec::<String>::new());
        assert_eq!(servers(&s).await?, Vec::<Value>::new());
    }
    // An explicit list larger than a few KiB is accepted; repeats import once.
    let many = json!({"source":"codex", "instructions":false, "servers":vec!["github"; 600]});
    let selected = call(&admin, "start", Some(many)).await?;
    assert_eq!(selected["servers"], 1);
    assert_eq!(servers(&s).await?.len(), 1);
    // A blank instruction file is not offered as a selectable item.
    write(&s.sandbox.home, ".codex/AGENTS.override.md", " \n");
    let rows = call(&admin, "sources", None).await?;
    let rows = rows["sources"].as_array().unwrap();
    let codex = rows.iter().find(|row| row["key"] == "codex").unwrap();
    assert_eq!(codex["instructions"], false);
    assert_eq!(codex["items"]["instructions"], json!([]));
    s.finish().await
}
