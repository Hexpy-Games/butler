use super::{git_support::*, *};

#[tokio::test]
async fn pg10_each_growth_requires_review_removals_narrow_and_rollback_refuses()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    for kind in [
        "executable",
        "network",
        "files",
        "mcp_server",
        "secret",
        "hook",
        "hook_script",
        "connector",
        "connector_server",
        "connector_action",
        "connector_organize",
    ] {
        growth(kind).await?;
    }
    Ok(())
}
async fn growth(kind: &str) -> Result<(), HarnessError> {
    let setup = git_setup(&format!("PG10-{kind}"))?;
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    let repo = Repo::new(&setup.sandbox.home, "helper", true)?;
    edit(&repo.work.join("plugin.json"), |v| {
        v["extensions"]["io.github.hexpy-games.butler"]["capabilities"] =
            json!({"files":[{"path":"/workspace/notes","access":"read"}]});
    });
    if kind.starts_with("connector_") {
        edit(&repo.work.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["connectors"] = json!([{
                "id":"items","label":"Items","events":{"server":"notes"},"context":{"tool":"notes/e2e_echo"},
                "actions":if kind=="connector_organize"{json!([{"tool":"notes/e2e_echo"}])}else{json!([])}
            }]);
        });
        if kind == "connector_server" {
            edit(&repo.work.join("mcp.json"), |v| {
                v["mcpServers"]["other"] = v["mcpServers"]["notes"].clone();
            });
        }
    }
    repo.publish();
    let baseline = ["plugin.json", "mcp.json", "hooks.json"]
        .map(|p| (p, fs::read(repo.work.join(p)).unwrap()));
    let mut s = setup.start().await?;
    let first = install_source(&s, json!({"git":repo.url})).await?;
    apply_growth(&repo, kind);
    repo.version("2.0.0");
    repo.nonce("approved-output");
    repo.publish();
    let review = check(&s, true).await?;
    assert_eq!(review["status"], "needs_review", "{kind}: {review}");
    let expected_kind = if kind == "hook_script" {
        "hook"
    } else if kind.starts_with("connector") {
        "connector"
    } else {
        kind
    };
    let pending = &review["pending"];
    assert!(
        pending["uncovered"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == expected_kind && v["new"] == true),
        "{review}"
    );
    assert_eq!(inventory(&s).await?["content_digest"], first["digest"]);
    echo(&s, "package-output").await?;
    if kind == "network" {
        let unrelated = package(&s.sandbox.home, "unrelated")?;
        inspect(&s, &unrelated).await?;
        s.restart().await?;
        assert_eq!(
            fs::read_dir(s.sandbox.data.join("plugins/staging"))?.count(),
            1
        );
        assert_eq!(
            inventory(&s).await?["pending"]["staging_id"],
            pending["staging_id"]
        );
    }
    let r=api(&s,Method::POST,"/plugins/helper/update",Some(json!({"revision":revision(&s).await?,"staging_id":pending["staging_id"],"digest":pending["digest"],"secrets":if kind=="secret" {json!({"NEW_SECRET":"fixture-secret"})}else{json!({})}}))).await?;
    assert_eq!(r.status, 200, "{kind}: {r:?}");
    assert_eq!(inventory(&s).await?["content_digest"], pending["digest"]);
    echo(&s, "approved-output").await?;
    // Remove the added capability while retaining the approved hook content.
    for (path, bytes) in baseline {
        if !kind.starts_with("hook") || path != "hooks.json" {
            fs::write(repo.work.join(path), bytes)?;
        }
    }
    if kind.starts_with("hook") {
        // Removing a hook, including its script, must remain a silent removal.
        edit(&repo.work.join("hooks.json"), |v| v["hooks"] = json!([]));
    }
    if kind == "connector_server" {
        // Switching an event source back is still growth; removing the connector narrows consent.
        edit(&repo.work.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["connectors"] = json!([]);
        });
    }
    repo.version("3.0.0");
    repo.publish();
    let removed = check(&s, true).await?;
    assert_eq!(removed["applied"], true, "{kind}: {removed}");
    let p = inventory(&s).await?;
    match kind {
        "network" => assert_eq!(p["capabilities"]["network"], json!([])),
        "files" => assert_eq!(
            p["capabilities"]["files"],
            json!([{"path":"/workspace/notes","access":"read"}])
        ),
        "secret" => assert_eq!(p["capabilities"]["secrets"], json!([])),
        "mcp_server" => assert_eq!(p["capabilities"]["agent_tools"], json!(["helper/notes"])),
        "hook" | "hook_script" => assert_eq!(p["capabilities"]["hooks"], json!([])),
        _ => {}
    }
    let refused = api(
        &s,
        Method::POST,
        "/plugins/helper/rollback",
        Some(json!({"revision":revision(&s).await?})),
    )
    .await?;
    assert_eq!(refused.status, 400, "{kind}: {refused:?}");
    assert!(refused.text.contains("plugin_rollback_needs_review"));
    echo(&s, "package-output").await?;
    s.finish().await
}
fn apply_growth(repo: &Repo, kind: &str) {
    match kind {
        "connector_server" | "connector_action" | "connector_organize" => {
            edit(&repo.work.join("plugin.json"), |v| {
                let c = &mut v["extensions"]["io.github.hexpy-games.butler"]["connectors"][0];
                match kind {
                    "connector_server" => c["events"]["server"] = "other".into(),
                    "connector_action" => c["actions"] = json!([{"tool":"notes/e2e_echo"}]),
                    _ => c["actions"][0]["organize"] = true.into(),
                }
            });
        }
        "connector" => edit(&repo.work.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["connectors"] = json!([{
                "id":"items","label":"Items","events":{"server":"notes"},"context":{"tool":"notes/e2e_echo"},"actions":[]
            }]);
        }),
        "executable" => {
            fs::copy(repo.work.join("server.exe"), repo.work.join("extra.exe")).unwrap();
            edit(&repo.work.join("mcp.json"), |v| {
                v["mcpServers"]["extra"] = v["mcpServers"]["notes"].clone();
                v["mcpServers"]["extra"]["command"] = json!("${BUTLER_PLUGIN_ROOT}/extra.exe");
            });
        }
        "network" => edit(&repo.work.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["capabilities"]["network"] =
                json!(["https://new.example.invalid/path"]);
        }),
        "files" => edit(&repo.work.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["capabilities"]["files"] =
                json!([{"path":"/workspace","access":"read_write"}]);
        }),
        "mcp_server" => edit(&repo.work.join("mcp.json"), |v| {
            v["mcpServers"]["extra"] = v["mcpServers"]["notes"].clone();
        }),
        "secret" => edit(&repo.work.join("plugin.json"), |v| {
            v["extensions"]["io.github.hexpy-games.butler"]["capabilities"]["secrets"] =
                json!([{"key":"NEW_SECRET","label":"New key"}]);
        }),
        "hook" => edit(&repo.work.join("hooks.json"), |v| {
            v["hooks"][0]["timeout_ms"] = json!(9000);
        }),
        "hook_script" => {
            let hooks: Value =
                serde_json::from_slice(&fs::read(repo.work.join("hooks.json")).unwrap()).unwrap();
            let script = hooks["hooks"][0]["args"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .find_map(|a| a.strip_prefix("${BUTLER_PLUGIN_ROOT}/"))
                .unwrap();
            let path = repo.work.join(script);
            let mut bytes = fs::read(&path).unwrap();
            bytes.extend_from_slice(b"\n");
            fs::write(path, bytes).unwrap();
        }
        _ => panic!("unknown growth kind"),
    }
}
